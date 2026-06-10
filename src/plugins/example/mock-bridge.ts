import type {
	CaptureTakenPayload,
	CaptureVariant,
	DeeplinkOpenedPayload,
	KiririnPluginBridge,
	KiririnRuntimeInfo,
	Playable,
	PlayerPlaybackState,
} from "../../Plugin";

export type ExampleBridge = KiririnPluginBridge & {
	__example?: {
		simulateDeeplink: (url?: string) => void;
		simulateCapture: () => void;
		cycleFocusedPlayer: () => void;
	};
};

const PLAYABLES: Playable[] = [
	{
		playerID: "player-live",
		id: "playable-live",
		title: "Kiririn Live Demo",
		subtitle: "Mock Live Broadcast",
		isSeekable: false,
		program: {
			name: "Morning Dispatch",
			description: "Safari Web Extension mock bridge for panel and overlay.",
			startAt: Math.floor(
				new Date("2026-05-23T07:00:00+09:00").getTime() / 1000,
			),
			endAt: Math.floor(new Date("2026-05-23T08:00:00+09:00").getTime() / 1000),
			duration: 3600,
			extended: [["MC", "Kiririn Bot"]],
			genres: [{ lv1: 2, name: "ニュース・報道" }],
		},
		service: {
			name: "Kiririn TV",
			serviceId: 101,
			networkId: 32736,
			type: { value: 1, description: "Digital TV" },
		},
	},
	{
		playerID: "player-vod",
		id: "playable-vod",
		title: "Kiririn Archive Demo",
		subtitle: "Recorded Program",
		isSeekable: true,
		length: 1500,
		program: {
			name: "Archive Preview",
			description: "Seekable mock playback for the example plugin.",
			startAt: Math.floor(
				new Date("2026-05-22T23:00:00+09:00").getTime() / 1000,
			),
			endAt: Math.floor(new Date("2026-05-22T23:25:00+09:00").getTime() / 1000),
			duration: 1500,
			extended: [["Cast", "Example Host"]],
			genres: [{ lv1: 6, name: "ドラマ" }],
		},
		service: {
			name: "Kiririn Archive",
			serviceId: 205,
			networkId: 4,
			type: { value: 1, description: "On-demand" },
		},
	},
];

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
	const initialTime = playable.isSeekable ? 180 : 540;
	const initialPosition = playable.length ? initialTime / playable.length : 0;

	return {
		playerID: playable.playerID,
		playableID: playable.id,
		isPlaying: playable.playerID === "player-live",
		time: initialTime,
		position: initialPosition,
		rate: 1,
	};
}

function createCaptureSVG(type: CaptureVariant) {
	const accent = type === "original" ? "#8ff0d2" : "#f8c36a";
	const label = type === "original" ? "Original" : "Composite";
	return `
		<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
			<defs>
				<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0%" stop-color="#08121c" />
					<stop offset="100%" stop-color="#12314a" />
				</linearGradient>
			</defs>
			<rect width="1280" height="720" fill="url(#bg)" />
			<circle cx="980" cy="180" r="120" fill="${accent}" fill-opacity="0.28" />
			<circle cx="260" cy="540" r="200" fill="#5bc0eb" fill-opacity="0.18" />
			<text x="92" y="160" fill="#edf7ff" font-size="64" font-family="Avenir Next, Helvetica Neue, sans-serif">Kiririn Example Capture</text>
			<text x="92" y="248" fill="#9ab2c7" font-size="34" font-family="Avenir Next, Helvetica Neue, sans-serif">${label} variant from mock bridge</text>
			<text x="92" y="612" fill="${accent}" font-size="44" font-family="Avenir Next, Helvetica Neue, sans-serif">${new Date().toLocaleTimeString("ja-JP")}</text>
		</svg>
	`;
}

class MockBridge implements ExampleBridge {
	private readonly playables = clonePlayables(PLAYABLES);
	private readonly statuses = new Map(
		PLAYABLES.map((playable) => [playable.playerID, createStatus(playable)]),
	);
	private readonly playablesCallbacks: Array<(playables: Playable[]) => void> =
		[];
	private readonly statusCallbacks: Array<
		(statuses: PlayerPlaybackState[]) => void
	> = [];
	private readonly focusCallbacks: Array<(id: string | null) => void> = [];
	private readonly closedCallbacks: Array<(playerID: string) => void> = [];
	private readonly deeplinkCallbacks: Array<
		(payload: DeeplinkOpenedPayload) => void
	> = [];
	private readonly captureCallbacks: Array<
		(payload: CaptureTakenPayload) => void
	> = [];
	private readonly captureBlobs = new Map<string, Map<CaptureVariant, Blob>>();

	private focusedPlayerID: string | null = PLAYABLES[0]?.playerID ?? null;
	private readonly timerID = window.setInterval(() => {
		this.tick();
	}, 1000);

	readonly __example = {
		simulateDeeplink: (url?: string) => {
			const payload = {
				url:
					url ??
					`https://kiririn.example/plugin?source=mock&at=${encodeURIComponent(
						new Date().toISOString(),
					)}`,
			};
			for (const callback of this.deeplinkCallbacks) {
				callback(payload);
			}
		},
		simulateCapture: () => {
			const captureID = crypto.randomUUID();
			const capturedAt = new Date();
			const variants = ["original", "composite"] as const;
			const blobs = new Map<CaptureVariant, Blob>();

			for (const variant of variants) {
				blobs.set(
					variant,
					new Blob([createCaptureSVG(variant)], { type: "image/svg+xml" }),
				);
			}

			this.captureBlobs.set(captureID, blobs);

			const payload: CaptureTakenPayload = {
				captureID,
				playerID:
					this.focusedPlayerID ?? PLAYABLES[0]?.playerID ?? "player-live",
				capturedAt,
				variants: variants.map((variant) => ({
					type: variant,
					overlayPluginManifestIDs:
						variant === "composite"
							? ["io.github.ci7lus.kiririn-plugins.example"]
							: [],
				})),
			};

			for (const callback of this.captureCallbacks) {
				callback(payload);
			}
		},
		cycleFocusedPlayer: () => {
			if (this.playables.length === 0) {
				return;
			}

			const currentIndex = this.playables.findIndex(
				(playable) => playable.playerID === this.focusedPlayerID,
			);
			const nextIndex = (currentIndex + 1) % this.playables.length;
			this.focusedPlayerID = this.playables[nextIndex]?.playerID ?? null;
			this.notifyFocus();
		},
	};

	constructor() {
		window.addEventListener(
			"beforeunload",
			() => {
				window.clearInterval(this.timerID);
			},
			{ once: true },
		);
	}

	getPlayables() {
		return clonePlayables(this.playables);
	}

	onPlayablesChange(callback: (playables: Playable[]) => void) {
		this.playablesCallbacks.push(callback);
		queueMicrotask(() => callback(this.getPlayables()));
	}

	getPlayerStatuses() {
		return cloneStatuses(this.statuses);
	}

	onPlayerStatusesChange(callback: (statuses: PlayerPlaybackState[]) => void) {
		this.statusCallbacks.push(callback);
		queueMicrotask(() => callback(this.getPlayerStatuses()));
	}

	getFocusedPlayerID() {
		return this.focusedPlayerID;
	}

	onFocusedPlayerIDChange(callback: (id: string | null) => void) {
		this.focusCallbacks.push(callback);
		queueMicrotask(() => callback(this.focusedPlayerID));
	}

	onPlayerClosed(callback: (playerID: string) => void) {
		this.closedCallbacks.push(callback);
	}

	getPlayable(playerID: string) {
		return (
			this.getPlayables().find((playable) => playable.playerID === playerID) ??
			null
		);
	}

	getPlayerStatus(playerID: string) {
		return (
			this.getPlayerStatuses().find((status) => status.playerID === playerID) ??
			null
		);
	}

	getRuntimeInfo(): KiririnRuntimeInfo {
		const displayAreaType = detectDisplayAreaType();
		return {
			platform: "macOS",
			osVersion: "15.0",
			appVersion: "0.1.0-dev",
			buildVersion: "example-dev",
			bundleIdentifier: "io.github.ci7lus.kiririn.dev",
			bridgeVersion: 1,
			displayAreaType,
			playerID: displayAreaType === "overlay" ? this.focusedPlayerID : null,
		};
	}

	onDeeplinkOpened(callback: (payload: DeeplinkOpenedPayload) => void) {
		this.deeplinkCallbacks.push(callback);
	}

	onCaptureTaken(callback: (payload: CaptureTakenPayload) => void) {
		this.captureCallbacks.push(callback);
	}

	play(playerID?: string) {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		status.isPlaying = true;
		this.notifyStatuses();
	}

	pause(playerID?: string) {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		status.isPlaying = false;
		this.notifyStatuses();
	}

	togglePlayPause(playerID?: string) {
		const status = this.resolveStatus(playerID);
		if (!status) {
			return;
		}

		status.isPlaying = !status.isPlaying;
		this.notifyStatuses();
	}

	seek(position: number, playerID?: string) {
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
		status.time = playable.length * nextPosition;
		this.notifyStatuses();
	}

	getCaptureBlob(captureID: string, variant: CaptureVariant) {
		return Promise.resolve(
			this.captureBlobs.get(captureID)?.get(variant) ?? null,
		);
	}

	sendMessage(type: string, data: unknown) {
		console.info("[Example MockBridge] sendMessage", type, data);
	}

	private resolveStatus(playerID?: string) {
		const targetID = playerID ?? this.focusedPlayerID;
		return targetID ? (this.statuses.get(targetID) ?? null) : null;
	}

	private tick() {
		let changed = false;

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

			changed = true;
		}

		if (changed) {
			this.notifyStatuses();
		}
	}

	private notifyStatuses() {
		const nextStatuses = this.getPlayerStatuses();
		for (const callback of this.statusCallbacks) {
			callback(nextStatuses);
		}
	}

	private notifyFocus() {
		for (const callback of this.focusCallbacks) {
			callback(this.focusedPlayerID);
		}
	}
}

export function getExampleBridge(): ExampleBridge {
	if (!window.kiririn) {
		window.kiririn = new MockBridge();
	}

	return window.kiririn as ExampleBridge;
}
