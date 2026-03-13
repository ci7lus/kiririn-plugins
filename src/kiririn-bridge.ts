import type { DisplayArea, KiririnBridge, Playable } from "./Plugin.d.ts";

const mockPlayable: Playable = {
	id: "mock-id",
	title: "サンプル番組タイトル",
	program: {
		name: "サンプル番組名",
		description:
			"これはサンプルの番組説明です。KiririnBridgeのデバッグ用データです。",
		startAt: Math.floor(Date.now() / 1000),
		endAt: Math.floor(Date.now() / 1000) + 3600,
		duration: 3600,
		genres: [{ lv1: 1, name: "趣味・教育" }],
		extended: [["出演者", "山田太郎, 佐藤花子"]],
	},
	service: {
		name: "サンプルチャンネル",
		serviceId: 101,
		networkId: 4,
		type: { value: 1, description: "デジタルTV" },
	},
};

const AREA_PATTERNS: DisplayArea[] = [
	{ type: "playerOverlay", width: 400, height: 200 },
	{ type: "pluginSettings", width: 600, height: 400 },
	{
		type: "pluginScreen",
		width: window.innerWidth,
		height: window.innerHeight,
	},
];

class MockBridge implements KiririnBridge {
	private playableCallbacks: ((p: Playable) => void)[] = [];
	private areaCallbacks: ((a: DisplayArea) => void)[] = [];
	private currentAreaIndex = 0;

	constructor() {
		window.addEventListener("resize", () => {
			if (AREA_PATTERNS[this.currentAreaIndex].type === "pluginScreen") {
				const newArea = this.getDisplayArea();
				this.notifyAreaUpdate(newArea);
			}
		});
	}

	getPlayable(): Playable | null {
		return mockPlayable;
	}

	onPlayableUpdate(callback: (playable: Playable) => void): void {
		this.playableCallbacks.push(callback);
		setTimeout(() => callback(mockPlayable), 0);
	}

	getDisplayArea(): DisplayArea {
		const area = AREA_PATTERNS[this.currentAreaIndex];
		if (area.type === "pluginScreen") {
			return { ...area, width: window.innerWidth, height: window.innerHeight };
		}
		return area;
	}

	onDisplayAreaUpdate(callback: (area: DisplayArea) => void): void {
		this.areaCallbacks.push(callback);
		setTimeout(() => callback(this.getDisplayArea()), 0);
	}

	sendMessage(type: string, data: any): void {
		console.log(`[MockBridge] sendMessage: ${type}`, data);
	}

	public nextAreaPattern(): DisplayArea {
		this.currentAreaIndex = (this.currentAreaIndex + 1) % AREA_PATTERNS.length;
		const newArea = this.getDisplayArea();
		this.notifyAreaUpdate(newArea);
		return newArea;
	}

	private notifyAreaUpdate(area: DisplayArea) {
		for (const cb of this.areaCallbacks) cb(area);
	}
}

export function initBridge(): KiririnBridge {
	if (typeof window !== "undefined" && !window.kiririn) {
		console.warn("KiririnBridge not found. Using MockBridge.");
		window.kiririn = new MockBridge() as any;
	}
	return window.kiririn;
}
