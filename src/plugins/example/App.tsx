import { type ReactNode, useEffect, useRef, useState } from "react";
import { initBridge } from "../../kiririn-bridge";
import type {
	CaptureTakenPayload,
	DisplayArea,
	KiririnBridge,
	Playable,
	PlayerPlaybackState,
} from "../../Plugin.d.ts";
import "./App.css";

const SETTINGS_STORAGE_KEY = "kiririn.example.settings";
const SETTINGS_CHANNEL_NAME = "kiririn.example.settings";

type ExampleSettings = {
	showPlayerOverlay: boolean;
};

type SettingsCandidate = Partial<ExampleSettings> & {
	showOverlay?: boolean;
	showPluginScreen?: boolean;
};

type CapturePreviewItem = {
	url: string;
	variant: string | null;
	sizeText: string;
	overlayPluginManifestIDs: string[];
};

type CapturePreviewState = {
	items: CapturePreviewItem[];
	status: string;
	currentIndex: number;
};

type RuntimeState = {
	area: DisplayArea | null;
	focusedPlayerID: string | null;
	playable: Playable | null;
	playbackState: PlayerPlaybackState | null;
	playables: Playable[];
	statuses: PlayerPlaybackState[];
};

type NormalizedDisplayArea = {
	type: DisplayArea["type"] | "unknown";
	playerID: string | null;
	width: number;
	height: number;
};

const DEFAULT_SETTINGS = Object.freeze<ExampleSettings>({
	showPlayerOverlay: true,
});

const INITIAL_RUNTIME_STATE: RuntimeState = {
	area: null,
	focusedPlayerID: null,
	playable: null,
	playbackState: null,
	playables: [],
	statuses: [],
};

const INITIAL_CAPTURE_PREVIEW_STATE: CapturePreviewState = {
	items: [],
	status: "キャプチャ待機中",
	currentIndex: 0,
};

function getTargetPlayerID(
	areaPlayerID: string | null | undefined,
	focusedPlayerID: string | null,
) {
	return focusedPlayerID || areaPlayerID || null;
}

function clampPreviewIndex(index: number, itemCount: number) {
	if (itemCount === 0) {
		return 0;
	}

	return Math.max(0, Math.min(index, itemCount - 1));
}

function cleanupCapturePreviewItems(items: CapturePreviewItem[]) {
	for (const item of items) {
		if (item.url) {
			URL.revokeObjectURL(item.url);
		}
	}
}

function normalizeSettings(candidate: unknown): ExampleSettings {
	const value =
		typeof candidate === "object" && candidate !== null
			? (candidate as SettingsCandidate)
			: null;

	return {
		showPlayerOverlay:
			typeof value?.showPlayerOverlay === "boolean"
				? value.showPlayerOverlay
				: typeof value?.showOverlay === "boolean"
					? value.showOverlay
					: typeof value?.showPluginScreen === "boolean"
						? value.showPluginScreen
						: DEFAULT_SETTINGS.showPlayerOverlay,
	};
}

function loadSettings(): ExampleSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
		return normalizeSettings(raw ? JSON.parse(raw) : null);
	} catch {
		return normalizeSettings(null);
	}
}

function formatTimestamp(seconds: number | null | undefined) {
	if (seconds == null) {
		return "-";
	}

	return new Date(seconds * 1000).toLocaleString("ja-JP", {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function formatDuration(seconds: number | null | undefined) {
	if (seconds == null) {
		return "-";
	}

	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total / 60);
	const remainSeconds = total % 60;

	if (hours > 0) {
		return `${hours}時間${minutes % 60}分${remainSeconds}秒`;
	}

	return minutes > 0 ? `${minutes}分${remainSeconds}秒` : `${remainSeconds}秒`;
}

function toAreaLabel(type: DisplayArea["type"] | "unknown") {
	switch (type) {
		case "playerOverlay":
			return "playerOverlay";
		case "pluginSettings":
			return "pluginSettings";
		case "pluginScreen":
			return "pluginScreen";
		default:
			return String(type || "unknown");
	}
}

function formatPlaybackTime(seconds: number | null | undefined) {
	if (seconds == null) {
		return "-";
	}

	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainSeconds = Math.floor(seconds % 60);

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
	}

	return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function formatPosition(value: number | null | undefined) {
	if (value == null) {
		return "-";
	}

	return `${Number(value).toFixed(4)} (${(Number(value) * 100).toFixed(2)}%)`;
}

function formatBoolean(value: boolean) {
	return value ? "true" : "false";
}

function formatDateLike(value: Date | string | null | undefined) {
	if (!value) {
		return "-";
	}

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}

	return date.toLocaleString("ja-JP", {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function shortID(id: string | null | undefined) {
	if (!id) {
		return "(none)";
	}

	if (id.length <= 10) {
		return id;
	}

	return `${id.slice(0, 8)}…`;
}

function normalizeGenre(
	genre:
		| NonNullable<NonNullable<Playable["program"]>["genres"]>[number]
		| null
		| undefined,
) {
	if (!genre) {
		return null;
	}

	return {
		lv1: typeof genre.lv1 === "number" ? genre.lv1 : null,
		lv2: typeof genre.lv2 === "number" ? genre.lv2 : null,
		name: genre.name || null,
	};
}

function normalizeProgram(program: Playable["program"] | null | undefined) {
	if (!program) {
		return null;
	}

	return {
		name: program.name || null,
		description: program.description || null,
		startAt: typeof program.startAt === "number" ? program.startAt : null,
		endAt: typeof program.endAt === "number" ? program.endAt : null,
		duration: typeof program.duration === "number" ? program.duration : null,
		eventId: typeof program.eventId === "number" ? program.eventId : null,
		extended: Array.isArray(program.extended) ? program.extended.slice() : [],
		genres: Array.isArray(program.genres)
			? program.genres.map(normalizeGenre)
			: [],
	};
}

function normalizeService(service: Playable["service"] | null | undefined) {
	if (!service) {
		return null;
	}

	return {
		name: service.name || null,
		serviceId: typeof service.serviceId === "number" ? service.serviceId : null,
		networkId: typeof service.networkId === "number" ? service.networkId : null,
		type: service.type
			? {
					value:
						typeof service.type.value === "number" ? service.type.value : null,
					description: service.type.description || null,
				}
			: null,
		channel: service.channel
			? {
					id: service.channel.id || null,
					type: service.channel.type || null,
				}
			: null,
	};
}

function normalizePlayable(playable: Playable | null | undefined) {
	if (!playable) {
		return null;
	}

	return {
		playerID: playable.playerID || null,
		id: playable.id || null,
		title: playable.title || null,
		subtitle: playable.subtitle || null,
		initialNetworkTime:
			typeof playable.initialNetworkTime === "number"
				? playable.initialNetworkTime
				: null,
		isSeekable: Boolean(playable.isSeekable),
		length: typeof playable.length === "number" ? playable.length : null,
		program: normalizeProgram(playable.program),
		service: normalizeService(playable.service),
	};
}

function normalizeStatus(status: PlayerPlaybackState | null | undefined) {
	if (!status) {
		return null;
	}

	return {
		playerID: status.playerID || null,
		playableID: status.playableID || null,
		isPlaying: Boolean(status.isPlaying),
		time: typeof status.time === "number" ? status.time : null,
		position: typeof status.position === "number" ? status.position : null,
		rate: typeof status.rate === "number" ? status.rate : null,
	};
}

function normalizeDisplayArea(
	area: DisplayArea | null | undefined,
): NormalizedDisplayArea {
	if (!area) {
		return {
			type: "unknown",
			playerID: null,
			width: window.innerWidth,
			height: window.innerHeight,
		};
	}

	return {
		type: area.type || "unknown",
		playerID: area.playerID || null,
		width: typeof area.width === "number" ? area.width : window.innerWidth,
		height: typeof area.height === "number" ? area.height : window.innerHeight,
	};
}

function normalizeCapture(capture: CaptureTakenPayload | null | undefined) {
	if (!capture) {
		return null;
	}

	return {
		playerID: capture.playerID || null,
		captureID: capture.captureID || null,
		capturedAt:
			capture.capturedAt instanceof Date
				? capture.capturedAt.toISOString()
				: capture.capturedAt || null,
		references: Array.isArray(capture.references)
			? capture.references.map((reference) => ({
					playerID: reference.playerID || null,
					captureID: reference.captureID || null,
					variant: reference.variant || null,
					overlayPluginManifestIDs: Array.isArray(
						reference.overlayPluginManifestIDs,
					)
						? reference.overlayPluginManifestIDs.slice()
						: [],
				}))
			: [],
	};
}

function buildPreviewSnapshot(previewState: CapturePreviewState) {
	const currentIndex = clampPreviewIndex(
		previewState.currentIndex,
		previewState.items.length,
	);

	return {
		hasImage: previewState.items.length > 0,
		status: previewState.status,
		itemCount: previewState.items.length,
		currentIndex,
		items: previewState.items.map((item) => ({
			variant: item.variant,
			sizeText: item.sizeText,
			overlayPluginManifestIDs: item.overlayPluginManifestIDs,
		})),
	};
}

function collectRuntimeState(bridge: KiririnBridge): RuntimeState {
	const area = bridge.getDisplayArea();
	const focusedPlayerID = bridge.getFocusedPlayerID();
	const targetPlayerID = getTargetPlayerID(
		area.playerID || null,
		focusedPlayerID,
	);

	return {
		area,
		focusedPlayerID,
		playable: targetPlayerID ? bridge.getPlayable(targetPlayerID) : null,
		playbackState: targetPlayerID
			? bridge.getPlayerStatus(targetPlayerID)
			: null,
		playables: bridge.getPlayables(),
		statuses: bridge.getPlayerStatuses(),
	};
}

function buildCaptureLoadStatus(
	nextItems: CapturePreviewItem[],
	referenceCount: number,
	failures: string[],
) {
	if (nextItems.length === 0) {
		return failures[0] || "Blob unavailable";
	}

	if (failures.length === 0) {
		return nextItems.length === 1
			? `${nextItems[0].variant || "image"} / ${nextItems[0].sizeText}`
			: `${nextItems.length} variants を読み込みました`;
	}

	return `${nextItems.length}/${referenceCount} variants を読み込みました`;
}

function buildFocusedSnapshot({
	settings,
	runtime,
	latestCapture,
	previewState,
}: {
	settings: ExampleSettings;
	runtime: RuntimeState;
	latestCapture: CaptureTakenPayload | null;
	previewState: CapturePreviewState;
}) {
	const area = normalizeDisplayArea(runtime.area);
	const targetPlayerID = getTargetPlayerID(
		area.playerID,
		runtime.focusedPlayerID,
	);

	return {
		settings: { showPlayerOverlay: settings.showPlayerOverlay },
		focusedPlayerID: runtime.focusedPlayerID,
		targetPlayerID,
		displayArea: area,
		playable: normalizePlayable(runtime.playable),
		playerStatus: normalizeStatus(runtime.playbackState),
		latestCapture: normalizeCapture(latestCapture),
		latestCapturePreview: buildPreviewSnapshot(previewState),
	};
}

function buildGlobalSnapshot({
	runtime,
	latestCapture,
	previewState,
}: {
	runtime: RuntimeState;
	latestCapture: CaptureTakenPayload | null;
	previewState: CapturePreviewState;
}) {
	return {
		focusedPlayerID: runtime.focusedPlayerID,
		playables: runtime.playables.map(normalizePlayable),
		playerStatuses: runtime.statuses.map(normalizeStatus),
		latestCapture: normalizeCapture(latestCapture),
		latestCapturePreview: buildPreviewSnapshot(previewState),
	};
}

function buildCaptureVariantLabel(
	capture: ReturnType<typeof normalizeCapture>,
) {
	if (!capture || capture.references.length === 0) {
		return "-";
	}

	return (
		capture.references
			.map((reference) => reference.variant)
			.filter(Boolean)
			.join(", ") || "-"
	);
}

function buildCaptureOverlayLabel(
	capture: ReturnType<typeof normalizeCapture>,
) {
	if (!capture) {
		return "-";
	}

	const overlayIDs = Array.from(
		new Set(
			capture.references.flatMap((reference) =>
				Array.isArray(reference.overlayPluginManifestIDs)
					? reference.overlayPluginManifestIDs
					: [],
			),
		),
	);

	return overlayIDs.length > 0 ? overlayIDs.join(", ") : "-";
}

function buildProgramWindow(playable: ReturnType<typeof normalizePlayable>) {
	if (!playable?.program) {
		return "-";
	}

	return `${formatTimestamp(playable.program.startAt)} - ${formatTimestamp(playable.program.endAt)}`;
}

function buildServiceLabel(playable: ReturnType<typeof normalizePlayable>) {
	if (!playable?.service) {
		return "-";
	}

	const service = playable.service;
	return `${service.name || "-"} / SID ${service.serviceId ?? "-"} / NID ${service.networkId ?? "-"}`;
}

function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="example-json-block">{JSON.stringify(value, null, 2)}</pre>
	);
}

function SummaryItem({ label, value }: { label: string; value: string }) {
	return (
		<div className="example-summary-item">
			<div className="example-summary-label">{label}</div>
			<div className="example-summary-value">{value}</div>
		</div>
	);
}

function Section({
	title,
	note,
	children,
}: {
	title: string;
	note?: string;
	children: ReactNode;
}) {
	return (
		<section className="example-section">
			<div className="example-section-header">
				<h2 className="example-section-title">{title}</h2>
				{note ? <p className="example-section-note">{note}</p> : null}
			</div>
			{children}
		</section>
	);
}

function JsonSection({
	title,
	note,
	data,
}: {
	title: string;
	note: string;
	data: unknown;
}) {
	return (
		<Section title={title} note={note}>
			<JsonBlock value={data} />
		</Section>
	);
}

function CapturePreviewSection({
	latestCapture,
	previewState,
	onPreviewIndexChange,
}: {
	latestCapture: CaptureTakenPayload | null;
	previewState: CapturePreviewState;
	onPreviewIndexChange: (index: number) => void;
}) {
	const capture = normalizeCapture(latestCapture);
	const clampedIndex = clampPreviewIndex(
		previewState.currentIndex,
		previewState.items.length,
	);
	const activePreview = previewState.items[clampedIndex] || null;

	return (
		<Section
			title="最新キャプチャプレビュー"
			note="onCaptureTaken で受けた最新 1 件だけを保持し、新しいイベント到着時に前回分を破棄します。"
		>
			<div className="example-summary-grid">
				<SummaryItem label="キャプチャID" value={capture?.captureID || "-"} />
				<SummaryItem label="プレイヤーID" value={capture?.playerID || "-"} />
				<SummaryItem
					label="撮影時刻"
					value={capture ? formatDateLike(capture.capturedAt) : "-"}
				/>
				<SummaryItem
					label="受信 variants"
					value={buildCaptureVariantLabel(capture)}
				/>
				<SummaryItem
					label="合成オーバーレイ"
					value={buildCaptureOverlayLabel(capture)}
				/>
				<SummaryItem label="Blob 取得結果" value={previewState.status || "-"} />
				<SummaryItem
					label="表示中 variant"
					value={activePreview?.variant || "-"}
				/>
			</div>

			{previewState.items.length > 0 ? (
				<>
					{previewState.items.length > 1 ? (
						<>
							<div className="example-carousel-header">
								<div className="example-carousel-meta">
									<p className="example-carousel-title">
										{activePreview?.variant || "preview"}
									</p>
									<p className="example-carousel-subtitle">
										{`${clampedIndex + 1} / ${previewState.items.length}${activePreview?.sizeText ? ` / ${activePreview.sizeText}` : ""}`}
									</p>
								</div>

								<div className="example-carousel-controls">
									<button
										className="example-carousel-button"
										type="button"
										disabled={clampedIndex === 0}
										onClick={() =>
											onPreviewIndexChange(Math.max(0, clampedIndex - 1))
										}
									>
										前へ
									</button>
									<span className="example-carousel-indicator">
										{`${clampedIndex + 1} / ${previewState.items.length}`}
									</span>
									<button
										className="example-carousel-button"
										type="button"
										disabled={clampedIndex >= previewState.items.length - 1}
										onClick={() =>
											onPreviewIndexChange(
												Math.min(
													previewState.items.length - 1,
													clampedIndex + 1,
												),
											)
										}
									>
										次へ
									</button>
								</div>
							</div>

							<div className="example-carousel-dots">
								{previewState.items.map((item, index) => (
									<button
										key={`${item.url}-${item.variant || "preview"}`}
										className={`example-carousel-dot${index === clampedIndex ? " is-active" : ""}`}
										type="button"
										aria-label={`${index + 1}枚目を表示`}
										title={item.variant || `${index + 1}`}
										onClick={() => onPreviewIndexChange(index)}
									/>
								))}
							</div>
						</>
					) : null}

					<div className="example-capture-preview-frame">
						<img
							className="example-capture-preview-image"
							src={activePreview?.url}
							alt="Latest capture preview"
						/>
					</div>
				</>
			) : (
				<div className="example-empty-state">
					{capture
						? previewState.status || "Blob 取得待機中です。"
						: "キャプチャイベント待機中です。"}
				</div>
			)}
		</Section>
	);
}

function PluginScreenView({
	settings,
	runtime,
	latestCapture,
	previewState,
	onPreviewIndexChange,
}: {
	settings: ExampleSettings;
	runtime: RuntimeState;
	latestCapture: CaptureTakenPayload | null;
	previewState: CapturePreviewState;
	onPreviewIndexChange: (index: number) => void;
}) {
	const area = normalizeDisplayArea(runtime.area);
	const targetPlayerID = getTargetPlayerID(
		area.playerID,
		runtime.focusedPlayerID,
	);
	const playable = normalizePlayable(runtime.playable);
	const status = normalizeStatus(runtime.playbackState);

	return (
		<main className="example-screen-scroll">
			<section className="example-hero-card">
				<div className="example-hero-top">
					<div>
						<p className="example-kicker">Plugin Screen</p>
						<h1 className="example-hero-title">
							{playable?.title || "フォーカス中メディアなし"}
						</h1>
						<p className="example-hero-subtitle">
							{playable?.subtitle ||
								"フォーカス中プレイヤーのメディア情報をそのまま展開しています。"}
						</p>
					</div>

					<div className="example-chip-row">
						<div
							className={`example-chip ${settings.showPlayerOverlay ? "is-on" : "is-off"}`}
						>
							{`PlayerOverlay: ${settings.showPlayerOverlay ? "ON" : "OFF"}`}
						</div>
						<div className="example-chip">
							{`表示領域: ${toAreaLabel(area.type)}`}
						</div>
						<div className="example-chip">
							{`フォーカス: ${shortID(runtime.focusedPlayerID)}`}
						</div>
					</div>
				</div>

				<div className="example-summary-grid">
					<SummaryItem
						label="フォーカスプレイヤーID"
						value={runtime.focusedPlayerID || "(none)"}
					/>
					<SummaryItem
						label="参照プレイヤーID"
						value={targetPlayerID || "(none)"}
					/>
					<SummaryItem label="コンテンツID" value={playable?.id || "-"} />
					<SummaryItem label="チャンネル" value={buildServiceLabel(playable)} />
					<SummaryItem label="放送時間" value={buildProgramWindow(playable)} />
					<SummaryItem label="長さ" value={formatDuration(playable?.length)} />
					<SummaryItem
						label="基準時刻 (iNT)"
						value={formatTimestamp(playable?.initialNetworkTime)}
					/>
					<SummaryItem
						label="シーク可否"
						value={playable ? formatBoolean(playable.isSeekable) : "-"}
					/>
					<SummaryItem
						label="再生中"
						value={status ? formatBoolean(status.isPlaying) : "-"}
					/>
					<SummaryItem
						label="再生時刻"
						value={formatPlaybackTime(status?.time)}
					/>
					<SummaryItem
						label="再生位置"
						value={formatPosition(status?.position)}
					/>
					<SummaryItem
						label="再生速度"
						value={status?.rate != null ? `${status.rate.toFixed(2)}x` : "-"}
					/>
					<SummaryItem
						label="最新キャプチャID"
						value={latestCapture?.captureID || "-"}
					/>
					<SummaryItem
						label="表示領域サイズ"
						value={`${Math.round(area.width)} x ${Math.round(area.height)}`}
					/>
				</div>
			</section>

			{!targetPlayerID ? (
				<div className="example-empty-state">
					フォーカス中のプレイヤーがないため、表示できるメディア情報はありません。プレイヤーをフォーカスするとここに反映されます。
				</div>
			) : null}

			<JsonSection
				title="フォーカス中メディアの取得結果"
				note="Playable / PlayerStatus / DisplayArea / Capture をまとめて表示します。"
				data={buildFocusedSnapshot({
					settings,
					runtime,
					latestCapture,
					previewState,
				})}
			/>
			<JsonSection
				title="現在参照できる全プレイヤー状態"
				note="getPlayables() / getPlayerStatuses() の全件です。"
				data={buildGlobalSnapshot({
					runtime,
					latestCapture,
					previewState,
				})}
			/>
			<CapturePreviewSection
				latestCapture={latestCapture}
				previewState={previewState}
				onPreviewIndexChange={onPreviewIndexChange}
			/>
		</main>
	);
}

function PlayerOverlayView({
	title,
	focusedPlayerID,
}: {
	title: string | null;
	focusedPlayerID: string | null;
}) {
	const label = title || `focus ${shortID(focusedPlayerID)}`;

	return (
		<div className="example-overlay-shell">
			<div className="example-overlay-badge">
				<div className="example-overlay-line">
					<span className="example-overlay-dot" />
					<span className="example-overlay-label">Kiririn Plugin</span>
				</div>
				<div className="example-overlay-meta">{`overlay / ${label}`}</div>
			</div>
		</div>
	);
}

function PluginSettingsView({
	settings,
	onToggleOverlay,
}: {
	settings: ExampleSettings;
	onToggleOverlay: (checked: boolean) => void;
}) {
	return (
		<div className="example-settings-shell">
			<section className="example-settings-panel">
				<h1 className="example-settings-title">PlayerOverlay 表示設定</h1>
				<p className="example-settings-copy">
					PlayerOverlay
					に小さな状態バッジを表示するかどうかを切り替えます。PluginScreen
					は常に表示され、同一プラグインの他の表示領域にも即時反映されます。
				</p>

				<label className="example-toggle-card" htmlFor="example-show-overlay">
					<div className="example-toggle-copy">
						<div className="example-toggle-label">PlayerOverlay を表示する</div>
					</div>

					<input
						id="example-show-overlay"
						className="example-toggle-input"
						type="checkbox"
						checked={settings.showPlayerOverlay}
						onChange={(event) => onToggleOverlay(event.target.checked)}
					/>
				</label>

				<p className="example-status-line">
					{`現在の値: ${settings.showPlayerOverlay ? "true" : "false"}`}
				</p>
			</section>
		</div>
	);
}

function App() {
	const [settings, setSettings] = useState<ExampleSettings>(() =>
		loadSettings(),
	);
	const [runtime, setRuntime] = useState<RuntimeState>(INITIAL_RUNTIME_STATE);
	const [latestCapturePayload, setLatestCapturePayload] =
		useState<CaptureTakenPayload | null>(null);
	const [capturePreviewState, setCapturePreviewState] =
		useState<CapturePreviewState>(INITIAL_CAPTURE_PREVIEW_STATE);
	const settingsChannelRef = useRef<BroadcastChannel | null>(null);
	const previewItemsRef = useRef<CapturePreviewItem[]>([]);
	const latestCapturePayloadRef = useRef<CaptureTakenPayload | null>(null);
	const latestCaptureRequestTokenRef = useRef(0);
	const debugKiririn = window.kiririn as
		| (KiririnBridge & {
				nextAreaPattern?: () => void;
		  })
		| undefined;

	const applySettings = (nextSettings: unknown, shouldPersist: boolean) => {
		const normalized = normalizeSettings(nextSettings);
		setSettings(normalized);

		if (!shouldPersist) {
			return;
		}

		try {
			localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
		} catch {}

		try {
			settingsChannelRef.current?.postMessage(normalized);
		} catch {}
	};

	useEffect(() => {
		setSettings(loadSettings());

		const handleStorage = (event: StorageEvent) => {
			if (event.key !== SETTINGS_STORAGE_KEY) {
				return;
			}

			try {
				setSettings(
					normalizeSettings(event.newValue ? JSON.parse(event.newValue) : null),
				);
			} catch {
				setSettings(normalizeSettings(null));
			}
		};

		let channel: BroadcastChannel | null = null;
		if (typeof BroadcastChannel === "function") {
			try {
				channel = new BroadcastChannel(SETTINGS_CHANNEL_NAME);
				settingsChannelRef.current = channel;
				channel.addEventListener("message", (event) => {
					setSettings(normalizeSettings(event.data));
				});
			} catch {
				settingsChannelRef.current = null;
			}
		}

		window.addEventListener("storage", handleStorage);

		return () => {
			window.removeEventListener("storage", handleStorage);
			channel?.close();
			if (settingsChannelRef.current === channel) {
				settingsChannelRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		const bridge = initBridge();

		const update = () => {
			setRuntime(collectRuntimeState(bridge));
		};

		const resetCapturePreview = (status: string) => {
			cleanupCapturePreviewItems(previewItemsRef.current);
			previewItemsRef.current = [];
			setCapturePreviewState({
				items: [],
				status,
				currentIndex: 0,
			});
		};

		const setCapturePreviewItems = (
			nextItems: CapturePreviewItem[],
			status: string,
		) => {
			cleanupCapturePreviewItems(previewItemsRef.current);
			previewItemsRef.current = nextItems;
			setCapturePreviewState({
				items: nextItems,
				status,
				currentIndex: 0,
			});
		};

		const handlePlayerClosed = (playerID: string) => {
			if (latestCapturePayloadRef.current?.playerID === playerID) {
				latestCaptureRequestTokenRef.current += 1;
				latestCapturePayloadRef.current = null;
				setLatestCapturePayload(null);
				resetCapturePreview("キャプチャ待機中");
			}

			update();
		};

		const handleCaptureTaken = async (payload: CaptureTakenPayload) => {
			latestCapturePayloadRef.current = payload;
			setLatestCapturePayload(payload);

			const references = Array.isArray(payload.references)
				? payload.references
				: [];
			// Ignore stale async completions when a newer capture replaces this request.
			const requestToken = latestCaptureRequestTokenRef.current + 1;
			latestCaptureRequestTokenRef.current = requestToken;

			resetCapturePreview(
				references.length > 0 ? "Blob 取得中..." : "取得可能な参照なし",
			);

			if (references.length === 0) {
				return;
			}

			try {
				const results = await Promise.all(
					references.map(async (reference) => {
						try {
							const blob = await bridge.getCaptureBlob(reference);
							return {
								reference,
								blob,
								error: null as string | null,
							};
						} catch (error) {
							return {
								reference,
								blob: null,
								error: error instanceof Error ? error.message : String(error),
							};
						}
					}),
				);

				if (requestToken !== latestCaptureRequestTokenRef.current) {
					return;
				}

				const nextItems: CapturePreviewItem[] = [];
				const failures: string[] = [];

				for (const result of results) {
					if (!result.blob) {
						failures.push(
							result.error ||
								`${result.reference.variant || "unknown"} unavailable`,
						);
						continue;
					}

					nextItems.push({
						url: URL.createObjectURL(result.blob),
						variant: result.reference.variant || null,
						sizeText: `${(result.blob.size / 1024).toFixed(1)} KiB`,
						overlayPluginManifestIDs: Array.isArray(
							result.reference.overlayPluginManifestIDs,
						)
							? result.reference.overlayPluginManifestIDs.slice()
							: [],
					});
				}

				if (requestToken !== latestCaptureRequestTokenRef.current) {
					cleanupCapturePreviewItems(nextItems);
					return;
				}

				if (nextItems.length === 0) {
					setCapturePreviewItems(
						[],
						buildCaptureLoadStatus(nextItems, references.length, failures),
					);
					return;
				}

				setCapturePreviewItems(
					nextItems,
					buildCaptureLoadStatus(nextItems, references.length, failures),
				);
			} catch (error) {
				if (requestToken !== latestCaptureRequestTokenRef.current) {
					return;
				}

				setCapturePreviewState((current) => ({
					...current,
					status: error instanceof Error ? error.message : String(error),
				}));
			}
		};

		update();
		bridge.onDisplayAreaChange(update);
		bridge.onPlayablesChange(update);
		bridge.onPlayerStatusesChange(update);
		bridge.onFocusedPlayerIDChange(update);
		bridge.onPlayerClosed(handlePlayerClosed);
		bridge.onCaptureTaken((payload) => {
			void handleCaptureTaken(payload);
		});
		window.addEventListener("resize", update);

		return () => {
			window.removeEventListener("resize", update);
			latestCaptureRequestTokenRef.current += 1;
			cleanupCapturePreviewItems(previewItemsRef.current);
			previewItemsRef.current = [];
		};
	}, []);

	if (!runtime.area) {
		return (
			<div className="example-loading-shell">
				<div className="example-loading-card">読み込み中...</div>
			</div>
		);
	}

	const area = normalizeDisplayArea(runtime.area);

	return (
		<div className={`example-root is-${area.type}`}>
			{area.type === "pluginScreen" ? (
				<PluginScreenView
					settings={settings}
					runtime={runtime}
					latestCapture={latestCapturePayload}
					previewState={capturePreviewState}
					onPreviewIndexChange={(index) => {
						setCapturePreviewState((current) => {
							return {
								...current,
								currentIndex: clampPreviewIndex(index, current.items.length),
							};
						});
					}}
				/>
			) : null}

			{area.type === "playerOverlay" && settings.showPlayerOverlay ? (
				<PlayerOverlayView
					title={runtime.playable?.title || null}
					focusedPlayerID={runtime.focusedPlayerID}
				/>
			) : null}

			{area.type === "pluginSettings" ? (
				<PluginSettingsView
					settings={settings}
					onToggleOverlay={(checked) => {
						applySettings({ showPlayerOverlay: checked }, true);
					}}
				/>
			) : null}

			{typeof debugKiririn?.nextAreaPattern === "function" ? (
				<button
					type="button"
					onClick={() => debugKiririn.nextAreaPattern?.()}
					className="example-debug-button"
				>
					Switch Area
				</button>
			) : null}
		</div>
	);
}

export default App;
