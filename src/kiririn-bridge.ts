import type {
	CaptureTakenPayload,
	CaptureVariant,
	DeeplinkOpenedPayload,
	KiririnBridge,
	KiririnRuntimeInfo,
	Playable,
	PlayerPlaybackState,
} from "./Plugin";

const mockPlayable: Playable = {
	playerID: "mock-player",
	id: "mock-id",
	title: "サンプル番組タイトル",
	isSeekable: false, // デフォルトは生放送
	program: {
		name: "サンプル番組名",
		description:
			"これはサンプルの番組説明です。KiririnBridgeのデバッグ用データです。",
		startAt: Math.floor(new Date("2026-03-14T17:00:00+09:00").getTime() / 1000),
		endAt: Math.floor(new Date("2026-03-14T18:00:00+09:00").getTime() / 1000),
		duration: 3600,
		genres: [{ lv1: 1, name: "趣味・教育" }],
		extended: [["出演者", "山田太郎, 佐藤花子"]],
	},
	service: {
		name: "サンプルチャンネル",
		serviceId: 1024,
		networkId: 32736,
		type: { value: 1, description: "デジタルTV" },
	},
};

function detectDisplayAreaType(): KiririnRuntimeInfo["displayAreaType"] {
	const fileName = window.location.pathname.split("/").pop() ?? "";

	if (fileName === "overlay.html") {
		return "overlay";
	}

	if (fileName === "options.html") {
		return "options";
	}

	return "panel";
}

function clonePlayables(playables: Playable[]) {
	return structuredClone(playables);
}

function cloneStatuses(statuses: Map<string, PlayerPlaybackState>) {
	return Array.from(statuses.values(), (status) => ({ ...status }));
}

function createStatus(playable: Playable): PlayerPlaybackState {
	const initialTime = playable.isSeekable ? 180 : 0;
	const initialPosition = playable.length ? initialTime / playable.length : 0;

	return {
		playerID: playable.playerID,
		playableID: playable.id,
		isPlaying: true,
		time: initialTime,
		position: initialPosition,
		rate: 1,
	};
}

class MockBridge implements KiririnBridge {
	private playables: Playable[] = [mockPlayable];
	private statuses = new Map<string, PlayerPlaybackState>(
		this.playables.map((playable) => [
			playable.playerID,
			createStatus(playable),
		]),
	);
	private focusedPlayerId: string | null = this.playables[0]?.playerID ?? null;

	private playablesCallbacks: ((p: Playable[]) => void)[] = [];
	private playerStatusesCallbacks: ((s: PlayerPlaybackState[]) => void)[] = [];
	private focusedIdCallbacks: ((id: string | null) => void)[] = [];
	private closeCallbacks: ((id: string) => void)[] = [];
	private deeplinkCallbacks: ((payload: DeeplinkOpenedPayload) => void)[] = [];
	private captureCallbacks: ((payload: CaptureTakenPayload) => void)[] = [];

	private timerId = window.setInterval(() => {
		this.tick();
	}, 1000);

	constructor() {
		window.addEventListener(
			"beforeunload",
			() => {
				window.clearInterval(this.timerId);
			},
			{ once: true },
		);
	}

	getPlayables(): Playable[] {
		return clonePlayables(this.playables);
	}

	onPlayablesChange(callback: (playables: Playable[]) => void): void {
		this.playablesCallbacks.push(callback);
		queueMicrotask(() => callback(this.getPlayables()));
	}

	getPlayerStatuses(): PlayerPlaybackState[] {
		return cloneStatuses(this.statuses);
	}

	onPlayerStatusesChange(
		callback: (statuses: PlayerPlaybackState[]) => void,
	): void {
		this.playerStatusesCallbacks.push(callback);
		queueMicrotask(() => callback(this.getPlayerStatuses()));
	}

	getFocusedPlayerID(): string | null {
		return this.focusedPlayerId;
	}

	onFocusedPlayerIDChange(callback: (id: string | null) => void): void {
		this.focusedIdCallbacks.push(callback);
		queueMicrotask(() => callback(this.focusedPlayerId));
	}

	onPlayerClosed(callback: (playerID: string) => void): void {
		this.closeCallbacks.push(callback);
	}

	getPlayable(playerID: string): Playable | null {
		return (
			this.getPlayables().find((p) => p.playerID === playerID) ||
			this.getPlayables()[0] ||
			null
		);
	}

	getPlayerStatus(playerID: string): PlayerPlaybackState | null {
		const statuses = this.getPlayerStatuses();
		const status = statuses.find(
			(candidate) => candidate.playerID === playerID,
		);
		return status || statuses[0] || null;
	}

	getRuntimeInfo(): KiririnRuntimeInfo {
		const displayAreaType = detectDisplayAreaType();

		return {
			platform: "macOS",
			osVersion: "15.0",
			appVersion: "0.1.0-dev",
			buildVersion: "nicojk-dev",
			bundleIdentifier: "io.github.ci7lus.kiririn.dev",
			bridgeVersion: 1,
			displayAreaType,
			playerID: displayAreaType === "overlay" ? this.focusedPlayerId : null,
		};
	}

	onDeeplinkOpened(callback: (payload: DeeplinkOpenedPayload) => void): void {
		this.deeplinkCallbacks.push(callback);
	}

	onCaptureTaken(callback: (payload: CaptureTakenPayload) => void): void {
		this.captureCallbacks.push(callback);
	}

	play(playerID?: string): void {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		status.isPlaying = true;
		this.notifyStatuses();
	}

	pause(playerID?: string): void {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		status.isPlaying = false;
		this.notifyStatuses();
	}

	togglePlayPause(playerID?: string): void {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		status.isPlaying = !status.isPlaying;
		this.notifyStatuses();
	}

	seek(position: number, playerID?: string): void {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		const playable = this.playables.find(
			(candidate) => candidate.playerID === status.playerID,
		);
		if (!playable?.isSeekable || typeof playable.length !== "number") {
			return;
		}

		const nextPosition = Math.max(0, Math.min(position, 1));
		status.position = nextPosition;
		status.time = Math.round(playable.length * nextPosition);
		this.notifyStatuses();
	}

	seekToTime(time: number, playerID?: string): void {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		const playable = this.playables.find(
			(candidate) => candidate.playerID === status.playerID,
		);
		if (!playable?.isSeekable || typeof playable.length !== "number") {
			return;
		}

		status.time = Math.max(0, Math.min(time, playable.length));
		status.position = playable.length > 0 ? status.time / playable.length : 0;
		this.notifyStatuses();
	}

	getCaptureBlob(
		_captureID: string,
		_variant: CaptureVariant,
	): Promise<Blob | null> {
		return Promise.resolve(null);
	}

	sendMessage(type: string, data: unknown): void {
		console.log(`[MockBridge] sendMessage: ${type}`, data);
	}

	public toggleSeekable(): void {
		this.playables = this.playables.map((playable) => {
			const nextIsSeekable = !playable.isSeekable;
			return {
				...playable,
				isSeekable: nextIsSeekable,
				length: nextIsSeekable
					? (playable.length ?? playable.program?.duration ?? 3600)
					: undefined,
			};
		});

		for (const playable of this.playables) {
			const status = this.statuses.get(playable.playerID);
			if (!status) {
				continue;
			}

			status.position =
				playable.isSeekable &&
				typeof playable.length === "number" &&
				playable.length > 0
					? status.time / playable.length
					: 0;
		}

		this.notifyPlayablesUpdate();
		this.notifyStatuses();
	}

	public focusPlayable(playerID: string | null): void {
		this.focusedPlayerId = playerID;
		this.notifyFocusedIdUpdate();
	}

	public closePlayer(playerID: string): void {
		this.playables = this.playables.filter((p) => p.playerID !== playerID);
		this.statuses.delete(playerID);
		if (this.focusedPlayerId === playerID) {
			this.focusedPlayerId = this.playables[0]?.playerID || null;
		}
		this.notifyPlayablesUpdate();
		this.notifyFocusedIdUpdate();
		this.notifyStatuses();
		for (const cb of this.closeCallbacks) cb(playerID);
	}

	private resolveStatus(playerID?: string) {
		const targetId = playerID ?? this.focusedPlayerId;
		return targetId ? (this.statuses.get(targetId) ?? null) : null;
	}

	private tick() {
		let didChange = false;

		for (const playable of this.playables) {
			const status = this.statuses.get(playable.playerID);
			if (!status?.isPlaying) {
				continue;
			}

			status.time += status.rate;
			if (playable.isSeekable && typeof playable.length === "number") {
				status.time = Math.min(status.time, playable.length);
				status.position =
					playable.length > 0 ? status.time / playable.length : 0;
				if (status.time >= playable.length) {
					status.isPlaying = false;
				}
			}

			didChange = true;
		}

		if (didChange) {
			this.notifyStatuses();
		}
	}

	private notifyPlayablesUpdate() {
		const nextPlayables = this.getPlayables();
		for (const cb of this.playablesCallbacks) cb(nextPlayables);
	}

	private notifyFocusedIdUpdate() {
		for (const cb of this.focusedIdCallbacks) cb(this.focusedPlayerId);
	}

	private notifyStatuses() {
		const nextStatuses = this.getPlayerStatuses();
		for (const cb of this.playerStatusesCallbacks) cb(nextStatuses);
	}
}

export function initBridge(): KiririnBridge {
	if (typeof window !== "undefined" && !window.kiririn) {
		console.warn("KiririnBridge not found. Using MockBridge.");
		window.kiririn = new MockBridge();
	}
	return window.kiririn;
}
