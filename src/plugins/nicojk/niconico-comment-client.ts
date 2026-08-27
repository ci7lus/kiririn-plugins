import type { NiconicoComment } from "./comment-client";
import type {
	ConnectionStatus,
	LiveCommentClient,
} from "./live-comment-client";
import {
	type DecodedChat,
	decodeChunkedEntry,
	decodeChunkedMessage,
	LengthDelimitedReader,
} from "./ndgr-protobuf";
import { resolveNiconicoWatchPage } from "./niconico-watch-page";
import type { ResolvedCommentSource } from "./source-resolver";

type CommentCallback = (comment: NiconicoComment) => void;
type StatusCallback = (status: ConnectionStatus) => void;
type SocketLike = WebSocket;

const WATCH_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;
const ANONYMOUS_USER_ID = "guest";

export interface NdgrRetryPolicy {
	maxNumberOfRetry: number;
	startingIntervalMs: number;
	timeMultiple: number;
	randomizationFactor: number;
}

export interface NdgrTimeoutPolicy {
	viewFetchHeaderMs: number;
	viewStreamReadMs: number;
	segmentFetchHeaderMs: number;
	segmentStreamReadMs: number;
}

export interface NiconicoCommentClientOptions {
	retry?: Partial<NdgrRetryPolicy>;
	timeouts?: Partial<NdgrTimeoutPolicy>;
	random?: () => number;
}

const DEFAULT_NDGR_RETRY_POLICY: NdgrRetryPolicy = {
	maxNumberOfRetry: 5,
	startingIntervalMs: 500,
	timeMultiple: 1.5,
	randomizationFactor: 0.5,
};

const DEFAULT_NDGR_TIMEOUT_POLICY: NdgrTimeoutPolicy = {
	viewFetchHeaderMs: 60_000,
	viewStreamReadMs: 60_000,
	segmentFetchHeaderMs: 10_000,
	segmentStreamReadMs: 30_000,
};

type NdgrTimeoutPhase = "fetch-header" | "stream-read";

class NdgrFetchTimeoutError extends Error {
	override readonly name = "NdgrFetchTimeoutError";

	constructor(requestKind: "view" | "segment", phase: NdgrTimeoutPhase) {
		super(`NicoNico ${requestKind} ${phase} timed out`);
	}
}

const OPACITY_MAIL_VALUES: Record<string, string> = {
	Normal: "nico:opacity:1",
	Translucent: "nico:opacity:0.5",
};

export function getNiconicoLiveVpos(receivedAtMs: number, dateUsec: number) {
	const baseVpos = Math.floor(receivedAtMs / 10);
	const jitter = Math.floor((dateUsec % 100_000) / 2_000);
	return baseVpos + 200 + jitter;
}

export function getNdgrRetryDelayMs(
	retryNumber: number,
	policy: NdgrRetryPolicy = DEFAULT_NDGR_RETRY_POLICY,
	randomValue = Math.random(),
) {
	const baseDelay =
		policy.startingIntervalMs *
		policy.timeMultiple ** Math.max(0, retryNumber - 1);
	const jitterMultiplier =
		1 -
		policy.randomizationFactor +
		randomValue * policy.randomizationFactor * 2;
	return Math.max(0, Math.round(baseDelay * jitterMultiplier));
}

function isAbortError(error: unknown) {
	return error instanceof Error && error.name === "AbortError";
}

function getAbortError(signal: AbortSignal) {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The connection was aborted", "AbortError");
}

function createNdgrAttempt(parentSignal: AbortSignal) {
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(getAbortError(parentSignal));
	if (parentSignal.aborted) abortFromParent();
	else parentSignal.addEventListener("abort", abortFromParent, { once: true });

	return {
		signal: controller.signal,
		async runWithTimeout<T>(
			operation: () => Promise<T>,
			timeoutMs: number,
			requestKind: "view" | "segment",
			phase: NdgrTimeoutPhase,
		) {
			if (parentSignal.aborted) throw getAbortError(parentSignal);
			const timeoutError = new NdgrFetchTimeoutError(requestKind, phase);
			const timeout = setTimeout(
				() => controller.abort(timeoutError),
				timeoutMs,
			);
			let removeAttemptAbortListener = () => {};
			const attemptAborted = new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(controller.signal.reason ?? timeoutError);
				controller.signal.addEventListener("abort", onAbort, { once: true });
				removeAttemptAbortListener = () =>
					controller.signal.removeEventListener("abort", onAbort);
			});
			try {
				return await Promise.race([operation(), attemptAborted]);
			} finally {
				clearTimeout(timeout);
				removeAttemptAbortListener();
			}
		},
		dispose() {
			parentSignal.removeEventListener("abort", abortFromParent);
		},
	};
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) =>
		signal.addEventListener("abort", () => resolve(), { once: true }),
	);
}

function waitForReconnect(signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, RECONNECT_DELAY_MS);
		const onAbort = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			resolve(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			resolve(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function modifierToMail(modifier: DecodedChat["modifier"]): string[] {
	if (!modifier) return [];
	const commands = [
		modifier.position,
		modifier.size,
		modifier.namedColor,
		modifier.fullColor,
		modifier.font,
		modifier.opacity ? OPACITY_MAIL_VALUES[modifier.opacity] : undefined,
	];
	return commands.filter((command): command is string => command != null);
}

export class NiconicoCommentClient implements LiveCommentClient {
	private readonly retryPolicy: NdgrRetryPolicy;
	private readonly timeoutPolicy: NdgrTimeoutPolicy;
	private readonly random: () => number;
	private socket: SocketLike | null = null;
	private bc: BroadcastChannel | null = null;
	private abortController: AbortController | null = null;
	private listeners: CommentCallback[] = [];
	private statusListeners: StatusCallback[] = [];
	private status: ConnectionStatus = "disconnected";
	private sourceKey: string | null = null;
	private generation = 0;
	private activeSegmentTasks = new Map<
		string,
		{ generation: number; task: Promise<void> }
	>();
	private seenSegmentUris = new Set<string>();

	constructor(options: NiconicoCommentClientOptions = {}) {
		this.retryPolicy = { ...DEFAULT_NDGR_RETRY_POLICY, ...options.retry };
		this.timeoutPolicy = {
			...DEFAULT_NDGR_TIMEOUT_POLICY,
			...options.timeouts,
		};
		this.random = options.random ?? Math.random;
	}

	public connect(
		source: ResolvedCommentSource,
		options?: { passive?: boolean },
	): void {
		if (this.sourceKey === source.key) return;
		this.disconnect();
		this.sourceKey = source.key;
		this.updateStatus("connecting");
		this.setupBroadcastChannel(source.key);
		if (!source.nicoliveCommunityId) {
			this.updateStatus("error");
			return;
		}

		if (options?.passive) {
			this.updateStatus("connected");
			return;
		}

		this.abortController = new AbortController();
		const generation = ++this.generation;
		void this.startWithLock(
			source,
			generation,
			this.abortController.signal,
		).catch((error) => {
			if (this.isCurrent(generation) && !this.abortController?.signal.aborted) {
				console.error("[NicoJK] NicoNico comment connection failed", error);
				this.updateStatus("error");
			}
		});
	}

	private async startWithLock(
		source: ResolvedCommentSource,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		const locks = globalThis.navigator?.locks;
		if (!locks) {
			await this.start(source, generation, signal);
			return;
		}
		await locks.request(
			`nicojk_niconico_lock_${source.key}`,
			{ ifAvailable: true },
			async (lock) => {
				if (lock) {
					await this.start(source, generation, signal);
					await waitForAbort(signal);
					return;
				}
				this.updateStatus("connected");
				await locks.request(
					`nicojk_niconico_lock_${source.key}`,
					async (promoted) => {
						if (!promoted || signal.aborted || !this.isCurrent(generation))
							return;
						await this.start(source, generation, signal);
						await waitForAbort(signal);
					},
				);
			},
		);
	}

	public disconnect(): void {
		this.generation += 1;
		this.abortController?.abort();
		this.abortController = null;
		this.activeSegmentTasks.clear();
		this.seenSegmentUris.clear();
		this.socket?.close();
		this.socket = null;
		this.bc?.close();
		this.bc = null;
		this.sourceKey = null;
		this.updateStatus("disconnected");
	}

	public getStatus(): ConnectionStatus {
		return this.status;
	}

	public onStatusUpdate(callback: StatusCallback): () => void {
		this.statusListeners.push(callback);
		callback(this.status);
		return () => {
			this.statusListeners = this.statusListeners.filter(
				(item) => item !== callback,
			);
		};
	}

	public onComment(callback: CommentCallback): () => void {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((item) => item !== callback);
		};
	}

	private async start(
		source: ResolvedCommentSource,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		if (!source.nicoliveCommunityId) {
			throw new Error("NicoNico community ID is unavailable");
		}
		while (this.isCurrent(generation) && !signal.aborted) {
			this.seenSegmentUris.clear();
			const sessionController = new AbortController();
			const abortSession = () => sessionController.abort();
			signal.addEventListener("abort", abortSession, { once: true });
			try {
				// WebSocket URL は再接続ごとに取り直す。古い視聴ページに含まれる
				// URL を再利用すると、失効後に回復できなくなる。
				const page = await resolveNiconicoWatchPage(source.nicoliveCommunityId);
				if (!this.isCurrent(generation) || signal.aborted) return;
				const viewUri = await this.openWatchSocket(
					page.webSocketUrl,
					sessionController.signal,
					generation,
					abortSession,
				);
				if (!this.isCurrent(generation) || signal.aborted) return;
				this.updateStatus("connected");
				await this.consumeView(
					viewUri,
					"now",
					page.vposBaseTime,
					sessionController.signal,
					generation,
				);
			} catch (error) {
				if (signal.aborted || !this.isCurrent(generation)) return;
				if (!isAbortError(error)) {
					console.error(
						"[NicoJK] NicoNico comment session failed; reconnecting",
						error,
					);
				}
			} finally {
				signal.removeEventListener("abort", abortSession);
				sessionController.abort();
			}

			if (signal.aborted || !this.isCurrent(generation)) return;
			this.updateStatus("connecting");
			if (!(await waitForReconnect(signal))) return;
		}
	}

	private openWatchSocket(
		url: string,
		signal: AbortSignal,
		generation: number,
		onDisconnected: () => void,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			this.socket = socket;
			let settled = false;
			let closedAfterMessageServer = false;
			const timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					socket.close();
					reject(new Error("Timed out waiting for NicoNico messageServer"));
				}
			}, WATCH_TIMEOUT_MS);
			const abort = () => {
				clearTimeout(timeout);
				socket.close();
				if (!settled) {
					settled = true;
					reject(new DOMException("The connection was aborted", "AbortError"));
				}
			};
			signal.addEventListener("abort", abort, { once: true });
			socket.onopen = () => {
				if (!this.isCurrent(generation) || signal.aborted) return;
				socket.send(
					JSON.stringify({ type: "startWatching", data: { reconnect: false } }),
				);
			};
			socket.onmessage = (event) => {
				try {
					if (closedAfterMessageServer) return;
					const message = JSON.parse(String(event.data));
					if (message.type === "ping") {
						socket.send(JSON.stringify({ type: "pong" }));
						return;
					}
					if (message.type === "disconnect") {
						onDisconnected();
						if (!settled) {
							settled = true;
							clearTimeout(timeout);
							reject(
								new Error(
									`NicoNico message-server disconnected: ${String(message.data?.reason || "unknown")}`,
								),
							);
						}
						return;
					}
					const viewUri =
						message.type === "messageServer"
							? message.data?.viewUri
							: undefined;
					if (typeof viewUri !== "string" || settled) return;
					settled = true;
					clearTimeout(timeout);
					signal.removeEventListener("abort", abort);
					// messageServer は View URI を取得するためだけの接続。NDGRClient
					// と同様にここで閉じ、以降の NDGR HTTP ストリームと結び付けない。
					closedAfterMessageServer = true;
					socket.close();
					if (this.socket === socket) this.socket = null;
					resolve(viewUri);
				} catch (error) {
					if (!settled) {
						settled = true;
						clearTimeout(timeout);
						reject(error);
					}
				}
			};
			socket.onerror = () => {
				if (settled && !closedAfterMessageServer) onDisconnected();
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					reject(new Error("NicoNico message-server WebSocket failed"));
				}
			};
			socket.onclose = () => {
				if (settled && !signal.aborted && !closedAfterMessageServer)
					onDisconnected();
				if (!settled && !signal.aborted) {
					settled = true;
					clearTimeout(timeout);
					reject(new Error("NicoNico message-server WebSocket closed"));
				}
			};
		});
	}

	private async runNdgrWithRetry<T>(
		signal: AbortSignal,
		generation: number,
		operation: () => Promise<T>,
	): Promise<T> {
		let retryNumber = 0;
		while (true) {
			if (signal.aborted || !this.isCurrent(generation)) {
				throw getAbortError(signal);
			}
			try {
				return await operation();
			} catch (error) {
				if (signal.aborted || !this.isCurrent(generation)) throw error;
				if (retryNumber >= this.retryPolicy.maxNumberOfRetry) throw error;
				retryNumber += 1;
				const delayMs = getNdgrRetryDelayMs(
					retryNumber,
					this.retryPolicy,
					this.random(),
				);
				if (!(await waitForRetry(delayMs, signal))) throw getAbortError(signal);
			}
		}
	}

	private async consumeView(
		viewUri: string,
		at: number | "now",
		vposBaseTime: number,
		signal: AbortSignal,
		generation: number,
	): Promise<void> {
		let cursorAt: number | "now" | undefined = at;
		while (
			cursorAt !== undefined &&
			this.isCurrent(generation) &&
			!signal.aborted
		) {
			cursorAt = await this.consumeViewSegment(
				viewUri,
				cursorAt,
				vposBaseTime,
				signal,
				generation,
			);
		}
	}

	private async consumeViewSegment(
		viewUri: string,
		at: number | "now",
		vposBaseTime: number,
		signal: AbortSignal,
		generation: number,
	): Promise<number | undefined> {
		return this.runNdgrWithRetry(signal, generation, () =>
			this.consumeViewSegmentAttempt(
				viewUri,
				at,
				vposBaseTime,
				signal,
				generation,
			),
		);
	}

	private async consumeViewSegmentAttempt(
		viewUri: string,
		at: number | "now",
		vposBaseTime: number,
		signal: AbortSignal,
		generation: number,
	): Promise<number | undefined> {
		const url = new URL(viewUri);
		url.searchParams.set("at", String(at));
		const attemptContext = createNdgrAttempt(signal);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await attemptContext.runWithTimeout(
				() =>
					fetch(url, {
						cache: "no-store",
						credentials: "omit",
						signal: attemptContext.signal,
					}),
				this.timeoutPolicy.viewFetchHeaderMs,
				"view",
				"fetch-header",
			);
			if (!response.ok || !response.body)
				throw new Error(`NicoNico view request failed: ${response.status}`);
			reader = response.body.getReader();
			const frames = new LengthDelimitedReader();
			let nextAt: number | undefined;
			while (true) {
				const result = await attemptContext.runWithTimeout(
					() =>
						reader?.read() ?? Promise.reject(new Error("View reader missing")),
					this.timeoutPolicy.viewStreamReadMs,
					"view",
					"stream-read",
				);
				if (result.done) break;
				for (const frame of frames.push(result.value)) {
					const entry = decodeChunkedEntry(frame);
					if (entry.segment?.uri) {
						this.startSegment(
							entry.segment.uri,
							vposBaseTime,
							signal,
							generation,
						);
					}
					if (entry.next) nextAt = entry.next.at;
				}
			}
			if (frames.hasPendingFrame()) {
				throw new Error("NicoNico view stream ended with a truncated frame");
			}
			return nextAt;
		} finally {
			try {
				reader?.releaseLock();
			} catch {
				// Aborting a timed-out read may keep the lock until rejection settles.
			}
			attemptContext.dispose();
		}
	}

	private startSegment(
		segmentUri: string,
		vposBaseTime: number,
		signal: AbortSignal,
		generation: number,
	): void {
		const active = this.activeSegmentTasks.get(segmentUri);
		if (active?.generation === generation) return;
		if (active) this.activeSegmentTasks.delete(segmentUri);
		if (this.seenSegmentUris.has(segmentUri)) return;
		this.seenSegmentUris.add(segmentUri);

		let task: Promise<void>;
		task = this.consumeSegment(segmentUri, vposBaseTime, signal, generation)
			.catch((error) => {
				if (!this.isIntentionalFailure(error, signal, generation)) {
					console.error("[NicoJK] NicoNico comment segment failed", error);
				}
			})
			.finally(() => {
				if (this.activeSegmentTasks.get(segmentUri)?.task === task) {
					this.activeSegmentTasks.delete(segmentUri);
				}
			});
		this.activeSegmentTasks.set(segmentUri, { generation, task });
	}

	private async consumeSegment(
		segmentUri: string,
		vposBaseTime: number,
		signal: AbortSignal,
		generation: number,
	): Promise<void> {
		return this.runNdgrWithRetry(signal, generation, () =>
			this.consumeSegmentAttempt(segmentUri, vposBaseTime, signal, generation),
		);
	}

	private async consumeSegmentAttempt(
		segmentUri: string,
		vposBaseTime: number,
		signal: AbortSignal,
		generation: number,
	): Promise<void> {
		const attemptContext = createNdgrAttempt(signal);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await attemptContext.runWithTimeout(
				() =>
					fetch(segmentUri, {
						cache: "no-store",
						credentials: "omit",
						signal: attemptContext.signal,
					}),
				this.timeoutPolicy.segmentFetchHeaderMs,
				"segment",
				"fetch-header",
			);
			if (!response.ok || !response.body)
				throw new Error(`NicoNico segment request failed: ${response.status}`);
			reader = response.body.getReader();
			const frames = new LengthDelimitedReader();
			while (true) {
				const result = await attemptContext.runWithTimeout(
					() =>
						reader?.read() ??
						Promise.reject(new Error("Segment reader missing")),
					this.timeoutPolicy.segmentStreamReadMs,
					"segment",
					"stream-read",
				);
				if (result.done) break;
				for (const frame of frames.push(result.value)) {
					const message = decodeChunkedMessage(frame).message;
					const chat = message?.chat ?? message?.overflowedChat;
					if (chat && this.isCurrent(generation)) {
						this.notifyListeners(this.toComment(chat, vposBaseTime));
					}
				}
			}
			if (frames.hasPendingFrame()) {
				throw new Error("NicoNico segment stream ended with a truncated frame");
			}
		} finally {
			try {
				reader?.releaseLock();
			} catch {
				// Aborting a timed-out read may keep the lock until rejection settles.
			}
			attemptContext.dispose();
		}
	}

	private toComment(chat: DecodedChat, vposBaseTime: number): NiconicoComment {
		const absoluteSeconds = vposBaseTime + chat.vpos / 100;
		const date = Math.floor(absoluteSeconds);
		const dateUsec = Math.round((absoluteSeconds - date) * 1_000_000);
		return {
			id: chat.no,
			no: chat.no,
			vpos: getNiconicoLiveVpos(Date.now(), dateUsec),
			content: chat.content,
			date,
			date_usec: dateUsec,
			mail: modifierToMail(chat.modifier),
			user_id: chat.rawUserId ?? chat.hashedUserId ?? ANONYMOUS_USER_ID,
			premium: 0,
			anonymity: 1,
			origin: "ws",
		};
	}

	private isIntentionalFailure(
		error: unknown,
		signal: AbortSignal,
		generation: number,
	) {
		return signal.aborted || !this.isCurrent(generation) || isAbortError(error);
	}

	private setupBroadcastChannel(sourceKey: string) {
		this.bc = new BroadcastChannel(`nicojk_niconico_comments_${sourceKey}`);
		this.bc.onmessage = (event) => {
			if (event.data?.type === "comment")
				this.notifyListeners(
					{ ...event.data.payload, origin: "broadcast" },
					false,
				);
		};
	}

	private notifyListeners(comment: NiconicoComment, broadcast = true) {
		this.listeners.forEach((callback) => {
			callback(comment);
		});
		if (broadcast)
			this.bc?.postMessage({
				type: "comment",
				payload: { ...comment, origin: "ws" },
			});
	}

	private isCurrent(generation: number) {
		return generation === this.generation;
	}

	private updateStatus(status: ConnectionStatus) {
		this.status = status;
		this.statusListeners.forEach((callback) => {
			callback(status);
		});
	}
}
