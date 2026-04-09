import ReconnectingWebSocket from "reconnecting-websocket";

export interface NiconicoComment {
	id: number;
	no: number;
	vpos: number;
	content: string;
	date: number;
	date_usec: number;
	mail: string;
	user_id: string;
	premium: number;
	anonymity: number;
	origin?: "ws" | "broadcast";
}

type CommentCallback = (comment: NiconicoComment) => void;
type HistoryCallback = (comments: NiconicoComment[]) => void;
export type ConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";
type StatusCallback = (status: ConnectionStatus) => void;

interface RoomData {
	messageServer: {
		uri: string;
	};
	threadId: string;
	yourPostKey: string;
	keepIntervalSec?: number;
}

export class CommentClient {
	private watchWs: ReconnectingWebSocket | null = null;
	private commentWs: ReconnectingWebSocket | null = null;
	private bc: BroadcastChannel | null = null;
	private listeners: CommentCallback[] = [];
	private historyListeners: HistoryCallback[] = [];
	private statusListeners: StatusCallback[] = [];
	private jkId: string | null = null;
	private isLeader = false;
	private abortController: AbortController | null = null;
	private keepSeatInterval: number | null = null;
	private status: ConnectionStatus = "disconnected";
	private commentCounter = 0;

	public getMode(): "live" | "disconnected" {
		return this.jkId ? "live" : "disconnected";
	}

	public getStatus(): ConnectionStatus {
		return this.status;
	}

	constructor() {
		// sessionStorage の他タブからの更新を監視
		window.addEventListener("storage", (ev) => {
			if (this.jkId && ev.key === this.getStorageKey(this.jkId)) {
				const history = this.loadHistory(this.jkId);
				this.notifyHistoryListeners(history);
			}
		});
	}

	private setupBC(jkId: string) {
		if (this.bc) {
			this.bc.close();
		}
		this.bc = new BroadcastChannel(`nicojk_comments_${jkId}`);
		this.bc.onmessage = (ev) => {
			if (ev.data.type === "comment") {
				this.notifyListeners({ ...ev.data.payload, origin: "broadcast" });
			} else if (ev.data.type === "history") {
				const history = ev.data.payload as NiconicoComment[];
				this.notifyHistoryListeners(
					history.map((c) => ({ ...c, origin: "broadcast" })),
				);
			}
		};
	}

	public async connect(jkId: string, options?: { passive?: boolean }) {
		if (this.jkId === jkId) return;
		this.disconnect();
		this.jkId = jkId;
		this.updateStatus("connecting");

		// 接続時に sessionStorage から即座に履歴を読み込んで通知する
		const history = this.loadHistory(jkId);
		this.notifyHistoryListeners(history);

		this.setupBC(jkId);

		if (options?.passive) {
			console.log(`[NicoJK] Passive mode for ${jkId}. Monitoring BC only.`);
			this.updateStatus("connected");
			return;
		}

		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		if (navigator.locks) {
			navigator.locks.request(
				`nicojk_lock_${jkId}`,
				{ ifAvailable: true },
				async (lock) => {
					if (lock) {
						this.isLeader = true;
						console.log(`[NicoJK] Acquired lock for ${jkId} as Leader.`);
						this.setupWatchSession(jkId);
						return new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve());
						});
					} else {
						this.isLeader = false;
						console.log(
							`[NicoJK] Follower for ${jkId}. Waiting for promotion...`,
						);
						this.updateStatus("connected");

						// Background wait for promotion
						navigator.locks.request(`nicojk_lock_${jkId}`, async (lock) => {
							if (!signal.aborted && lock) {
								this.isLeader = true;
								console.log(`[NicoJK] Promoted to Leader for ${jkId}.`);
								this.setupWatchSession(jkId);
								return new Promise<void>((resolve) => {
									signal.addEventListener("abort", () => resolve());
								});
							}
						});
					}
				},
			);
		} else {
			this.setupWatchSession(jkId);
		}
	}

	private setupWatchSession(jkId: string) {
		const id = jkId.startsWith("jk") ? jkId : `jk${jkId}`;
		const url = `wss://nx-jikkyo.tsukumijima.net/api/v1/channels/${id}/ws/watch`;

		this.watchWs = new ReconnectingWebSocket(url);

		this.watchWs.onopen = () => {
			console.log("[NicoJK] Watch WS Connected");
			this.updateStatus("connecting");
			this.watchWs?.send(
				JSON.stringify({
					type: "startWatching",
					data: {
						stream: {
							quality: "abr",
							protocol: "hls",
							latency: "low",
							chasePlay: false,
						},
						room: {
							protocol: "webSocket",
							commentable: true,
						},
						reconnect: false,
					},
				}),
			);
		};

		this.watchWs.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);
				switch (msg.type) {
					case "room":
						if (msg.data) {
							const roomData = msg.data as RoomData;
							this.setupCommentSession(roomData);
						}
						break;
					case "ping":
						this.watchWs?.send(JSON.stringify({ type: "pong" }));
						break;
					case "seat":
						if (msg.data?.keepIntervalSec) {
							if (this.keepSeatInterval) clearInterval(this.keepSeatInterval);
							this.keepSeatInterval = setInterval(() => {
								this.watchWs?.send(JSON.stringify({ type: "keepSeat" }));
							}, msg.data.keepIntervalSec * 1000);
						}
						break;
					case "disconnect":
						this.watchWs?.close();
						break;
				}
			} catch (e) {
				console.error("Watch WS Parse error", e);
			}
		};

		this.watchWs.onclose = () => {
			console.log("[NicoJK] Watch WS Closed");
			this.updateStatus("disconnected");
			if (this.keepSeatInterval) {
				clearInterval(this.keepSeatInterval);
				this.keepSeatInterval = null;
			}
		};
	}

	private setupCommentSession(room: RoomData) {
		if (this.commentWs) {
			this.commentWs.close();
		}

		this.commentWs = new ReconnectingWebSocket(room.messageServer.uri);

		this.commentWs.onopen = () => {
			console.log("[NicoJK] Comment WS Connected");
			this.updateStatus("connected");
			this.commentWs?.send(
				JSON.stringify([
					{ ping: { content: "rs:0" } },
					{ ping: { content: "ps:0" } },
					{
						thread: {
							thread: room.threadId,
							version: "20061206",
							user_id: "guest",
							res_from: 0,
							with_global: 1,
							scores: 1,
							nicoru: 0,
						},
					},
					{ ping: { content: "pf:0" } },
					{ ping: { content: "rf:0" } },
				]),
			);
		};

		this.commentWs.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.chat) {
					const c = data.chat;
					const baseVpos = Math.floor(Date.now() / 10);
					const jitter = Math.floor((c.date_usec % 100000) / 2000);
					const vpos = baseVpos + 200 + jitter;

					const comment: NiconicoComment = {
						id: c.no || Date.now() * 1000 + (this.commentCounter++ % 1000),
						no: c.no,
						vpos,
						content: c.content || "",
						date: c.date,
						date_usec: c.date_usec || 0,
						mail: c.mail || "",
						user_id: c.user_id,
						premium: c.premium || 0,
						anonymity: c.anonymity || 0,
						origin: "ws",
					};

					this.notifyListeners(comment);
					this.broadcast(comment);
				}
			} catch (e) {
				console.error("Comment WS Parse error", e);
			}
		};

		this.commentWs.onclose = () => {
			console.log("[NicoJK] Comment WS Closed");
			this.updateStatus("disconnected");
		};

		this.commentWs.onerror = () => {
			this.updateStatus("error");
		};
	}

	public disconnect() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		if (this.keepSeatInterval) {
			clearInterval(this.keepSeatInterval);
			this.keepSeatInterval = null;
		}
		if (this.watchWs) {
			this.watchWs.close();
			this.watchWs = null;
		}
		if (this.commentWs) {
			this.commentWs.close();
			this.commentWs = null;
		}
		if (this.bc) {
			this.bc.close();
			this.bc = null;
		}
		this.jkId = null;
		this.isLeader = false;
		this.updateStatus("disconnected");
	}

	public onStatusUpdate(callback: StatusCallback) {
		this.statusListeners.push(callback);
		callback(this.status);
		return () => {
			this.statusListeners = this.statusListeners.filter(
				(cb) => cb !== callback,
			);
		};
	}

	private updateStatus(status: ConnectionStatus) {
		this.status = status;
		for (const cb of this.statusListeners) {
			cb(status);
		}
	}

	public onComment(callback: CommentCallback) {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((cb) => cb !== callback);
		};
	}

	public onHistoryUpdate(callback: HistoryCallback) {
		this.historyListeners.push(callback);
		return () => {
			this.historyListeners = this.historyListeners.filter(
				(cb) => cb !== callback,
			);
		};
	}

	private notifyListeners(comment: NiconicoComment) {
		for (const cb of this.listeners) {
			cb(comment);
		}
	}

	private notifyHistoryListeners(comments: NiconicoComment[]) {
		for (const cb of this.historyListeners) {
			cb(comments);
		}
	}

	private getStorageKey(jkId: string): string {
		return `nicojk_comments_v2_${jkId}`;
	}

	private loadHistory(jkId: string): NiconicoComment[] {
		const saved = sessionStorage.getItem(this.getStorageKey(jkId));
		if (!saved) return [];
		try {
			return JSON.parse(saved);
		} catch {
			return [];
		}
	}

	private saveHistory(jkId: string, comments: NiconicoComment[]) {
		sessionStorage.setItem(
			this.getStorageKey(jkId),
			JSON.stringify(comments.slice(-500)),
		);
	}

	public broadcastHistory(comments: NiconicoComment[]) {
		this.bc?.postMessage({ type: "history", payload: comments });
	}

	private broadcast(comment: NiconicoComment) {
		this.bc?.postMessage({ type: "comment", payload: comment });

		if (this.jkId) {
			const history = this.loadHistory(this.jkId);
			if (
				!history.some(
					(h) => (h.no && h.no === comment.no) || h.id === comment.id,
				)
			) {
				const nextHistory = [...history, comment].slice(-500);
				this.saveHistory(this.jkId, nextHistory);
				this.notifyHistoryListeners(nextHistory);
			}
		}
	}
}
