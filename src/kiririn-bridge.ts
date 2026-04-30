import type {
	DisplayArea,
	KiririnBridge,
	Playable,
	PlayerPlaybackState,
} from "./Plugin.d.ts";

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

const AREA_PATTERNS: DisplayArea[] = [
	{ type: "playerOverlay", playerID: "mock-player", width: 1280, height: 720 },
	{ type: "pluginSettings", width: 600, height: 400 },
	{
		type: "pluginScreen",
		width: window.innerWidth,
		height: window.innerHeight,
	},
];

class MockBridge implements KiririnBridge {
	private playables: Playable[] = [mockPlayable];
	private focusedPlayerId: string | null = "mock-player";

	private playablesCallbacks: ((p: Playable[]) => void)[] = [];
	private playerStatusesCallbacks: ((s: PlayerPlaybackState[]) => void)[] = [];
	private focusedIdCallbacks: ((id: string | null) => void)[] = [];
	private areaCallbacks: ((a: DisplayArea) => void)[] = [];
	private closeCallbacks: ((id: string) => void)[] = [];

	private currentAreaIndex = 0;
	private startTime = Date.now();

	constructor() {
		window.addEventListener("resize", () => {
			if (AREA_PATTERNS[this.currentAreaIndex].type === "pluginScreen") {
				const newArea = this.getDisplayArea();
				this.notifyAreaUpdate(newArea);
			}
		});

		// Simulate playback
		setInterval(() => {
			for (const cb of this.playerStatusesCallbacks) {
				cb(this.getPlayerStatuses());
			}
		}, 1000);
	}

	getPlayables(): Playable[] {
		return this.playables;
	}

	onPlayablesChange(callback: (playables: Playable[]) => void): void {
		this.playablesCallbacks.push(callback);
		setTimeout(() => callback(this.playables), 0);
	}

	getPlayerStatuses(): PlayerPlaybackState[] {
		const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
		return this.playables.map((p) => ({
			playerID: p.playerID,
			playableID: p.id,
			isPlaying: true,
			time: elapsed,
			position: elapsed / 3600,
		}));
	}

	onPlayerStatusesChange(
		callback: (statuses: PlayerPlaybackState[]) => void,
	): void {
		this.playerStatusesCallbacks.push(callback);
	}

	getFocusedPlayerID(): string | null {
		return this.focusedPlayerId;
	}

	onFocusedPlayerIDChange(callback: (id: string | null) => void): void {
		this.focusedIdCallbacks.push(callback);
		setTimeout(() => callback(this.focusedPlayerId), 0);
	}

	onPlayerClosed(callback: (playerID: string) => void): void {
		this.closeCallbacks.push(callback);
	}

	getPlayable(playerID: string): Playable | null {
		return (
			this.playables.find((p) => p.playerID === playerID) ||
			this.playables[0] ||
			null
		);
	}

	getPlayerStatus(playerID: string): PlayerPlaybackState | null {
		const statuses = this.getPlayerStatuses();
		const s = statuses.find((s) => s.playerID === playerID);
		return s || statuses[0] || null;
	}

	getDisplayArea(): DisplayArea {
		const area = AREA_PATTERNS[this.currentAreaIndex];
		if (area.type === "pluginScreen") {
			return { ...area, width: window.innerWidth, height: window.innerHeight };
		}
		return area;
	}

	onDisplayAreaChange(callback: (area: DisplayArea) => void): void {
		this.areaCallbacks.push(callback);
		setTimeout(() => callback(this.getDisplayArea()), 0);
	}

	play(_playerID?: string): void {}

	pause(_playerID?: string): void {}

	togglePlayPause(_playerID?: string): void {}

	seek(_position: number, _playerID?: string): void {}

	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		return globalThis.fetch(input, init);
	}

	sendMessage(type: string, data: unknown): void {
		console.log(`[MockBridge] sendMessage: ${type}`, data);
	}

	public nextAreaPattern(): DisplayArea {
		this.currentAreaIndex = (this.currentAreaIndex + 1) % AREA_PATTERNS.length;
		const newArea = this.getDisplayArea();
		this.notifyAreaUpdate(newArea);
		return newArea;
	}

	public toggleSeekable(): void {
		for (const p of this.playables) {
			p.isSeekable = !p.isSeekable;
		}
		this.notifyPlayablesUpdate();
	}

	public addPlayable(): void {
		const newPlayerId = `player-${this.playables.length + 1}`;
		const newId = `id-${this.playables.length + 1}`;
		this.playables.push({
			...mockPlayable,
			playerID: newPlayerId,
			id: newId,
			title: `Title ${this.playables.length + 1}`,
		});
		this.notifyPlayablesUpdate();
	}

	public focusPlayable(playerID: string | null): void {
		this.focusedPlayerId = playerID;
		this.notifyFocusedIdUpdate();
	}

	public closePlayer(playerID: string): void {
		this.playables = this.playables.filter((p) => p.playerID !== playerID);
		if (this.focusedPlayerId === playerID) {
			this.focusedPlayerId = this.playables[0]?.playerID || null;
		}
		this.notifyPlayablesUpdate();
		for (const cb of this.closeCallbacks) cb(playerID);
	}

	private notifyPlayablesUpdate() {
		for (const cb of this.playablesCallbacks) cb([...this.playables]);
	}

	private notifyFocusedIdUpdate() {
		for (const cb of this.focusedIdCallbacks) cb(this.focusedPlayerId);
	}

	private notifyAreaUpdate(area: DisplayArea) {
		for (const cb of this.areaCallbacks) cb(area);
	}
}

export function initBridge(): KiririnBridge {
	if (typeof window !== "undefined" && !window.kiririn) {
		console.warn("KiririnBridge not found. Using MockBridge.");
		window.kiririn = new MockBridge();
	}
	return window.kiririn;
}
