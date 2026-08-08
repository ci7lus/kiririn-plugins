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

const OPACITY_MAIL_VALUES: Record<string, string> = {
	Normal: "nico:opacity:1",
	Translucent: "nico:opacity:0.5",
};

export function getNiconicoLiveVpos(receivedAtMs: number, dateUsec: number) {
	const baseVpos = Math.floor(receivedAtMs / 10);
	const jitter = Math.floor((dateUsec % 100_000) / 2_000);
	return baseVpos + 200 + jitter;
}

function isAbortError(error: unknown) {
	return error instanceof Error && error.name === "AbortError";
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
	private socket: SocketLike | null = null;
	private bc: BroadcastChannel | null = null;
	private abortController: AbortController | null = null;
	private listeners: CommentCallback[] = [];
	private statusListeners: StatusCallback[] = [];
	private status: ConnectionStatus = "disconnected";
	private sourceKey: string | null = null;
	private generation = 0;

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
		const page = await resolveNiconicoWatchPage(source.nicoliveCommunityId);
		if (!this.isCurrent(generation)) return;

		while (this.isCurrent(generation) && !signal.aborted) {
			const sessionController = new AbortController();
			const abortSession = () => sessionController.abort();
			signal.addEventListener("abort", abortSession, { once: true });
			let sessionSocket: SocketLike | null = null;
			try {
				const { viewUri, socket } = await this.openWatchSocket(
					page.webSocketUrl,
					sessionController.signal,
					generation,
					abortSession,
				);
				sessionSocket = socket;
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
				if (sessionSocket && this.socket === sessionSocket) {
					sessionSocket.close();
					this.socket = null;
				}
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
	): Promise<{ viewUri: string; socket: SocketLike }> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			this.socket = socket;
			let settled = false;
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
					resolve({ viewUri, socket });
				} catch (error) {
					if (!settled) {
						settled = true;
						clearTimeout(timeout);
						reject(error);
					}
				}
			};
			socket.onerror = () => {
				if (settled) onDisconnected();
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					reject(new Error("NicoNico message-server WebSocket failed"));
				}
			};
			socket.onclose = () => {
				if (settled && !signal.aborted) onDisconnected();
				if (!settled && !signal.aborted) {
					settled = true;
					clearTimeout(timeout);
					reject(new Error("NicoNico message-server WebSocket closed"));
				}
			};
		});
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
		const url = new URL(viewUri);
		url.searchParams.set("at", String(at));
		const response = await fetch(url, { credentials: "omit", signal });
		if (!response.ok || !response.body)
			throw new Error(`NicoNico view request failed: ${response.status}`);
		const reader = response.body.getReader();
		const frames = new LengthDelimitedReader();
		const segmentTasks: Promise<void>[] = [];
		let nextAt: number | undefined;
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				for (const frame of frames.push(result.value)) {
					const entry = decodeChunkedEntry(frame);
					if (entry.segment?.uri) {
						const segmentTask = this.consumeSegment(
							entry.segment.uri,
							vposBaseTime,
							signal,
							generation,
						);
						segmentTasks.push(
							segmentTask.catch((error) => {
								if (!this.isIntentionalFailure(error, signal, generation)) {
									// A segment is independent of the view stream. Its failure
									// should not make an otherwise active live connection red.
									console.error(
										"[NicoJK] NicoNico comment segment failed",
										error,
									);
								}
							}),
						);
					}
					if (entry.next) nextAt = entry.next.at;
				}
			}
			if (frames.hasPendingFrame()) {
				throw new Error("NicoNico view stream ended with a truncated frame");
			}
		} finally {
			reader.releaseLock();
			await Promise.allSettled(segmentTasks);
		}
		return nextAt;
	}

	private async consumeSegment(
		segmentUri: string,
		vposBaseTime: number,
		signal: AbortSignal,
		generation: number,
	): Promise<void> {
		const response = await fetch(segmentUri, { credentials: "omit", signal });
		if (!response.ok || !response.body)
			throw new Error(`NicoNico segment request failed: ${response.status}`);
		const reader = response.body.getReader();
		const frames = new LengthDelimitedReader();
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				for (const frame of frames.push(result.value)) {
					const message = decodeChunkedMessage(frame).message;
					const chat = message?.chat ?? message?.overflowedChat;
					if (chat && this.isCurrent(generation))
						this.notifyListeners(this.toComment(chat, vposBaseTime));
				}
			}
			if (frames.hasPendingFrame()) {
				throw new Error("NicoNico segment stream ended with a truncated frame");
			}
		} finally {
			reader.releaseLock();
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
