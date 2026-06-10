import {
	startTransition,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";
import type {
	CaptureTakenPayload,
	CaptureVariant,
	DeeplinkOpenedPayload,
	KiririnRuntimeInfo,
	Playable,
	PlayerPlaybackState,
} from "../../Plugin";
import { type ExampleBridge, getExampleBridge } from "./mock-bridge";
import "./App.css";

const SETTINGS_STORAGE_KEY = "kiririn.example.settings.v2";
const MAX_CAPTURE_PREVIEWS = 6;
const MAX_EVENT_LOG_ITEMS = 18;

type ExampleSettings = {
	overlayEnabled: boolean;
	jumpSeconds: number;
};

type CapturePreview = {
	key: string;
	captureID: string;
	type: CaptureVariant;
	url: string;
	overlayPluginManifestIDs: string[];
	capturedAt: string;
};

type EventLogItem = {
	id: string;
	label: string;
	detail: string;
	at: string;
};

type ExampleComFetchResult = {
	status: number;
	statusText: string;
	contentType: string | null;
	url: string;
	text: string;
	fetchedAt: string;
};

type ExampleComFetchState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "success"; result: ExampleComFetchResult }
	| { status: "error"; message: string };

type StorageChangeLike = {
	newValue?: unknown;
};

type BrowserStorageLike = {
	local?: {
		get: (key: string) => Promise<Record<string, unknown>>;
		set: (items: Record<string, unknown>) => Promise<void>;
	};
	onChanged?: {
		addListener: (
			listener: (
				changes: Record<string, StorageChangeLike>,
				areaName: string,
			) => void,
		) => void;
		removeListener: (
			listener: (
				changes: Record<string, StorageChangeLike>,
				areaName: string,
			) => void,
		) => void;
	};
};

const DEFAULT_SETTINGS = Object.freeze<ExampleSettings>({
	overlayEnabled: true,
	jumpSeconds: 15,
});

function getBrowserStorage(): BrowserStorageLike | undefined {
	return (
		globalThis as typeof globalThis & {
			browser?: {
				storage?: BrowserStorageLike;
			};
		}
	).browser?.storage;
}

function normalizeSettings(candidate: unknown): ExampleSettings {
	const value =
		typeof candidate === "object" && candidate != null
			? (candidate as Partial<ExampleSettings>)
			: null;

	return {
		overlayEnabled:
			typeof value?.overlayEnabled === "boolean"
				? value.overlayEnabled
				: DEFAULT_SETTINGS.overlayEnabled,
		jumpSeconds:
			typeof value?.jumpSeconds === "number" &&
			[5, 10, 15, 30, 60].includes(value.jumpSeconds)
				? value.jumpSeconds
				: DEFAULT_SETTINGS.jumpSeconds,
	};
}

async function loadSettings() {
	try {
		const storage = getBrowserStorage();
		if (storage?.local) {
			const stored = await storage.local.get(SETTINGS_STORAGE_KEY);
			return normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
		}

		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
		return normalizeSettings(raw ? JSON.parse(raw) : null);
	} catch {
		return DEFAULT_SETTINGS;
	}
}

async function saveSettings(settings: ExampleSettings) {
	const storage = getBrowserStorage();
	if (storage?.local) {
		await storage.local.set({
			[SETTINGS_STORAGE_KEY]: settings,
		});
		return;
	}

	localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function subscribeSettings(onChange: (settings: ExampleSettings) => void) {
	const storage = getBrowserStorage();
	if (storage?.onChanged) {
		const listener = (
			changes: Record<string, StorageChangeLike>,
			areaName: string,
		) => {
			if (areaName !== "local" || !(SETTINGS_STORAGE_KEY in changes)) {
				return;
			}

			onChange(normalizeSettings(changes[SETTINGS_STORAGE_KEY]?.newValue));
		};

		storage.onChanged.addListener(listener);
		return () => storage.onChanged?.removeListener(listener);
	}

	const listener = (event: StorageEvent) => {
		if (event.key !== SETTINGS_STORAGE_KEY) {
			return;
		}

		try {
			onChange(
				normalizeSettings(event.newValue ? JSON.parse(event.newValue) : null),
			);
		} catch {
			onChange(DEFAULT_SETTINGS);
		}
	};

	window.addEventListener("storage", listener);
	return () => window.removeEventListener("storage", listener);
}

function formatTimestamp(value: string | Date | null | undefined) {
	if (!value) {
		return "-";
	}

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}

	return date.toLocaleString("ja-JP", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function formatPlaybackTime(seconds: number | null | undefined) {
	if (seconds == null) {
		return "-";
	}

	const safeSeconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const remainSeconds = safeSeconds % 60;

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
	}

	return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function normalizeCapturedAtISO(value: unknown) {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime())
			? new Date().toISOString()
			: value.toISOString();
	}

	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed.toISOString();
		}
	}

	return new Date().toISOString();
}

function formatProgramRange(playable: Playable | null) {
	const startAt = playable?.program?.startAt;
	const endAt = playable?.program?.endAt;

	if (typeof startAt !== "number" || typeof endAt !== "number") {
		return "-";
	}

	return `${formatTimestamp(new Date(startAt * 1000))} - ${formatTimestamp(
		new Date(endAt * 1000),
	)}`;
}

function formatPercent(value: number | null | undefined) {
	if (value == null) {
		return "-";
	}

	return `${(value * 100).toFixed(1)}%`;
}

function formatRuntimeTarget(runtimeInfo: KiririnRuntimeInfo) {
	return runtimeInfo.playerID ?? "global";
}

function getActivePlayerID(
	runtimeInfo: KiririnRuntimeInfo,
	focusedPlayerID: string | null,
) {
	return runtimeInfo.playerID ?? focusedPlayerID;
}

function getPlayableByPlayerID(playables: Playable[], playerID: string | null) {
	return playerID
		? (playables.find((playable) => playable.playerID === playerID) ?? null)
		: null;
}

function getStatusByPlayerID(
	statuses: PlayerPlaybackState[],
	playerID: string | null,
) {
	return playerID
		? (statuses.find((status) => status.playerID === playerID) ?? null)
		: null;
}

function releaseCapturePreviews(previews: CapturePreview[]) {
	for (const preview of previews) {
		URL.revokeObjectURL(preview.url);
	}
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
	children: React.ReactNode;
}) {
	return (
		<section className="example-section">
			<div className="example-section-header">
				<div>
					<h2 className="example-section-title">{title}</h2>
					{note ? <p className="example-section-note">{note}</p> : null}
				</div>
			</div>
			{children}
		</section>
	);
}

function PlayerBadge({
	playable,
	status,
}: {
	playable: Playable | null;
	status: PlayerPlaybackState | null;
}) {
	if (!playable || !status) {
		return (
			<div className="example-empty-state">
				対象プレイヤーが見つかりません。
			</div>
		);
	}

	return (
		<div className="example-overlay-card">
			<p className="example-overlay-kicker">Overlay Example</p>
			<h1 className="example-overlay-title">{playable.title}</h1>
			<p className="example-overlay-copy">
				{status.isPlaying ? "再生中" : "一時停止中"} /{" "}
				{formatPlaybackTime(status.time)}
			</p>
			<div className="example-chip-row">
				<span className="example-chip">player: {playable.playerID}</span>
				<span className="example-chip">
					progress: {formatPercent(status.position)}
				</span>
			</div>
		</div>
	);
}

function ActionRow({ children }: { children: React.ReactNode }) {
	return <div className="example-action-row">{children}</div>;
}

function ActionButton({
	label,
	onClick,
	disabled = false,
	variant = "default",
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	variant?: "default" | "accent" | "ghost";
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={`example-button is-${variant}`}
		>
			{label}
		</button>
	);
}

function PanelView({
	runtimeInfo,
	activePlayerID,
	activePlayable,
	activeStatus,
	playables,
	statuses,
	lastOpenURL,
	captures,
	eventLog,
	settings,
	onTogglePlayPause,
	onSeekRelative,
	exampleComFetch,
	onFetchExampleCom,
	devControls,
}: {
	runtimeInfo: KiririnRuntimeInfo;
	activePlayerID: string | null;
	activePlayable: Playable | null;
	activeStatus: PlayerPlaybackState | null;
	playables: Playable[];
	statuses: PlayerPlaybackState[];
	lastOpenURL: DeeplinkOpenedPayload | null;
	captures: CapturePreview[];
	eventLog: EventLogItem[];
	settings: ExampleSettings;
	onTogglePlayPause: () => void;
	onSeekRelative: (deltaSeconds: number) => void;
	exampleComFetch: ExampleComFetchState;
	onFetchExampleCom: () => void;
	devControls: ExampleBridge["__example"] | undefined;
}) {
	const canSeek =
		Boolean(activePlayable?.isSeekable) &&
		typeof activePlayable?.length === "number";

	return (
		<div className="example-shell is-panel">
			<div className="example-scroll-area">
				<section className="example-hero-card">
					<div className="example-hero-top">
						<div>
							<p className="example-kicker">Kiririn Safari Web Extension</p>
							<h1 className="example-hero-title">Panel Page</h1>
							<p className="example-hero-subtitle">
								新しい bridge API を使って runtime / playables / capture /
								deeplink を表示します。
							</p>
						</div>
						<div className="example-chip-row">
							<span className="example-chip">
								target: {formatRuntimeTarget(runtimeInfo)}
							</span>
							<span className="example-chip">
								bridge v{runtimeInfo.bridgeVersion}
							</span>
							<span className="example-chip">
								overlay: {settings.overlayEnabled ? "on" : "off"}
							</span>
						</div>
					</div>
					<div className="example-summary-grid">
						<SummaryItem
							label="Platform"
							value={`${runtimeInfo.platform} ${runtimeInfo.osVersion}`}
						/>
						<SummaryItem
							label="App"
							value={runtimeInfo.appVersion ?? runtimeInfo.buildVersion}
						/>
						<SummaryItem
							label="Bundle"
							value={runtimeInfo.bundleIdentifier ?? "-"}
						/>
						<SummaryItem label="Area" value={runtimeInfo.displayAreaType} />
					</div>
				</section>

				<Section
					title="Active Player"
					note="play / pause / seek は focused player か overlay の playerID に対して送ります。"
				>
					<div className="example-summary-grid">
						<SummaryItem label="PlayerID" value={activePlayerID ?? "-"} />
						<SummaryItem
							label="PlayableID"
							value={activeStatus?.playableID ?? activePlayable?.id ?? "-"}
						/>
						<SummaryItem label="Title" value={activePlayable?.title ?? "-"} />
						<SummaryItem
							label="Subtitle"
							value={activePlayable?.subtitle ?? "-"}
						/>
						<SummaryItem
							label="Playback"
							value={
								activeStatus
									? activeStatus.isPlaying
										? "playing"
										: "paused"
									: "-"
							}
						/>
						<SummaryItem
							label="Time"
							value={formatPlaybackTime(activeStatus?.time)}
						/>
						<SummaryItem
							label="Position"
							value={formatPercent(activeStatus?.position)}
						/>
						<SummaryItem
							label="Rate"
							value={
								typeof activeStatus?.rate === "number"
									? `${activeStatus.rate.toFixed(2)}x`
									: "-"
							}
						/>
						<SummaryItem
							label="Seekable"
							value={activePlayable ? String(activePlayable.isSeekable) : "-"}
						/>
						<SummaryItem
							label="Length"
							value={formatPlaybackTime(activePlayable?.length)}
						/>
						<SummaryItem
							label="Program"
							value={activePlayable?.program?.name ?? "-"}
						/>
						<SummaryItem
							label="Program Time"
							value={formatProgramRange(activePlayable)}
						/>
						<SummaryItem
							label="Service"
							value={activePlayable?.service?.name ?? "-"}
						/>
						<SummaryItem
							label="Channel"
							value={activePlayable?.service?.channel?.id ?? "-"}
						/>
					</div>
					<ActionRow>
						<ActionButton
							label={activeStatus?.isPlaying ? "Pause" : "Play"}
							onClick={onTogglePlayPause}
							variant="accent"
							disabled={!activePlayable}
						/>
						<ActionButton
							label={`-${settings.jumpSeconds}s`}
							onClick={() => onSeekRelative(-settings.jumpSeconds)}
							disabled={!canSeek}
						/>
						<ActionButton
							label={`+${settings.jumpSeconds}s`}
							onClick={() => onSeekRelative(settings.jumpSeconds)}
							disabled={!canSeek}
						/>
					</ActionRow>
				</Section>

				{devControls ? (
					<Section
						title="Dev Controls"
						note="host bridge が無いときだけ mock bridge のイベントを発火できます。"
					>
						<ActionRow>
							<ActionButton
								label="Deep Link"
								onClick={() => devControls.simulateDeeplink()}
							/>
							<ActionButton
								label="Capture"
								onClick={() => devControls.simulateCapture()}
							/>
							<ActionButton
								label="Focus Player"
								onClick={() => devControls.cycleFocusedPlayer()}
								variant="ghost"
							/>
						</ActionRow>
					</Section>
				) : null}

				<Section
					title="Playables"
					note="getPlayables() の内容をそのまま列挙します。"
				>
					<div className="example-list-grid">
						{playables.map((playable) => {
							const status = statuses.find(
								(candidate) => candidate.playerID === playable.playerID,
							);

							return (
								<div key={playable.playerID} className="example-list-card">
									<h3 className="example-list-title">{playable.title}</h3>
									<p className="example-list-copy">
										playerID: {playable.playerID}
									</p>
									<p className="example-list-copy">id: {playable.id}</p>
									<p className="example-list-copy">
										subtitle: {playable.subtitle ?? "-"}
									</p>
									<p className="example-list-copy">
										{status?.isPlaying ? "再生中" : "停止中"} /{" "}
										{formatPlaybackTime(status?.time)}
									</p>
									<p className="example-list-copy">
										seekable: {String(playable.isSeekable)} / length:{" "}
										{formatPlaybackTime(playable.length)}
									</p>
									<p className="example-list-copy">
										position: {formatPercent(status?.position)} / rate:{" "}
										{typeof status?.rate === "number"
											? `${status.rate.toFixed(2)}x`
											: "-"}
									</p>
									<p className="example-list-copy">
										service: {playable.service?.name ?? "-"}
									</p>
									<p className="example-list-copy">
										program: {playable.program?.name ?? "-"}
									</p>
								</div>
							);
						})}
					</div>
				</Section>

				<Section
					title="Capture"
					note="onCaptureTaken() と getCaptureBlob() の結果です。"
				>
					{captures.length === 0 ? (
						<p className="example-empty-state">
							まだ capture event はありません。
						</p>
					) : (
						<div className="example-capture-grid">
							{captures.map((capture) => (
								<figure key={capture.key} className="example-capture-card">
									<img
										src={capture.url}
										alt={capture.type}
										className="example-capture-image"
									/>
									<figcaption className="example-capture-caption">
										<div>{capture.type}</div>
										<div>{formatTimestamp(capture.capturedAt)}</div>
									</figcaption>
								</figure>
							))}
						</div>
					)}
				</Section>

				<Section
					title="Deep Link"
					note="最後に受け取った onDeeplinkOpened payload です。"
				>
					<p className="example-json-block">
						{lastOpenURL ? lastOpenURL.url : "まだ deeplink は届いていません。"}
					</p>
				</Section>

				<Section
					title="External Fetch"
					note="https://example.com/ を取得します。"
				>
					<ActionRow>
						<ActionButton
							label={
								exampleComFetch.status === "loading"
									? "Fetching..."
									: "Fetch example.com"
							}
							onClick={onFetchExampleCom}
							variant="accent"
							disabled={exampleComFetch.status === "loading"}
						/>
					</ActionRow>
					{exampleComFetch.status === "idle" ? (
						<p className="example-empty-state">取得結果はまだありません。</p>
					) : null}
					{exampleComFetch.status === "error" ? (
						<p className="example-json-block">{exampleComFetch.message}</p>
					) : null}
					{exampleComFetch.status === "success" ? (
						<div className="example-external-fetch-result">
							<div className="example-summary-grid">
								<SummaryItem
									label="Status"
									value={`${exampleComFetch.result.status} ${exampleComFetch.result.statusText}`}
								/>
								<SummaryItem
									label="Content-Type"
									value={exampleComFetch.result.contentType ?? "-"}
								/>
								<SummaryItem
									label="Fetched At"
									value={formatTimestamp(exampleComFetch.result.fetchedAt)}
								/>
							</div>
							<p className="example-json-block">
								{exampleComFetch.result.text}
							</p>
						</div>
					) : null}
				</Section>

				<Section title="Event Log" note="bridge callback の到着順ログです。">
					<div className="example-log-list">
						{eventLog.length === 0 ? (
							<p className="example-empty-state">イベントはまだありません。</p>
						) : (
							eventLog.map((item) => (
								<div key={item.id} className="example-log-item">
									<div className="example-log-meta">{item.at}</div>
									<div className="example-log-label">{item.label}</div>
									<div className="example-log-detail">{item.detail}</div>
								</div>
							))
						)}
					</div>
				</Section>

				<button
					type="button"
					onClick={() => {
						// @ts-expect-error
						window.kiririn.invalidAPI();
					}}
				>
					kiririn.invalidAPI()
				</button>
			</div>
		</div>
	);
}

function OptionsView({
	runtimeInfo,
	settings,
	onUpdateSettings,
}: {
	runtimeInfo: KiririnRuntimeInfo;
	settings: ExampleSettings;
	onUpdateSettings: (patch: Partial<ExampleSettings>) => void;
}) {
	return (
		<div className="example-shell is-options">
			<div className="example-settings-panel">
				<p className="example-kicker">Plugin Settings</p>
				<h1 className="example-settings-title">Example Options</h1>
				<p className="example-settings-copy">
					browser.storage.local が使えるときはそちらへ、無いときは localStorage
					へ保存します。
				</p>

				<label className="example-setting-card">
					<div>
						<div className="example-setting-title">Overlay を表示する</div>
						<div className="example-setting-copy">
							overlay page で状態カードを描画するかを切り替えます。
						</div>
					</div>
					<input
						type="checkbox"
						checked={settings.overlayEnabled}
						onChange={(event) =>
							onUpdateSettings({ overlayEnabled: event.currentTarget.checked })
						}
					/>
				</label>

				<label className="example-setting-card">
					<div>
						<div className="example-setting-title">Seek Step</div>
						<div className="example-setting-copy">
							panel page の ±seek ボタンで使う秒数です。
						</div>
					</div>
					<select
						className="example-select"
						value={settings.jumpSeconds}
						onChange={(event) =>
							onUpdateSettings({
								jumpSeconds: Number(event.currentTarget.value),
							})
						}
					>
						{[5, 10, 15, 30, 60].map((value) => (
							<option key={value} value={value}>
								{value} sec
							</option>
						))}
					</select>
				</label>

				<div className="example-summary-grid">
					<SummaryItem label="Area" value={runtimeInfo.displayAreaType} />
					<SummaryItem
						label="Player Target"
						value={formatRuntimeTarget(runtimeInfo)}
					/>
					<SummaryItem label="Platform" value={runtimeInfo.platform} />
					<SummaryItem
						label="Bundle"
						value={runtimeInfo.bundleIdentifier ?? "-"}
					/>
				</div>
			</div>
		</div>
	);
}

export default function App() {
	const bridgeRef = useRef<ExampleBridge | null>(null);
	const captureRef = useRef<CapturePreview[]>([]);

	if (bridgeRef.current == null) {
		bridgeRef.current = getExampleBridge();
	}

	const bridge = bridgeRef.current;
	const [runtimeInfo] = useState(() => bridge.getRuntimeInfo());
	const [playables, setPlayables] = useState(() => bridge.getPlayables());
	const [statuses, setStatuses] = useState(() => bridge.getPlayerStatuses());
	const [focusedPlayerID, setFocusedPlayerID] = useState(() =>
		bridge.getFocusedPlayerID(),
	);
	const [settings, setSettings] = useState(DEFAULT_SETTINGS);
	const [lastOpenURL, setLastOpenURL] = useState<DeeplinkOpenedPayload | null>(
		null,
	);
	const [captures, setCaptures] = useState<CapturePreview[]>([]);
	const [eventLog, setEventLog] = useState<EventLogItem[]>([]);
	const [exampleComFetch, setExampleComFetch] = useState<ExampleComFetchState>({
		status: "idle",
	});

	const appendEvent = useEffectEvent((label: string, detail: string) => {
		startTransition(() => {
			setEventLog((current) =>
				[
					{
						id: crypto.randomUUID(),
						label,
						detail,
						at: formatTimestamp(new Date()),
					},
					...current,
				].slice(0, MAX_EVENT_LOG_ITEMS),
			);
		});
	});

	const appendCapturePreview = useEffectEvent(
		async (payload: CaptureTakenPayload) => {
			const capturedAtISO = normalizeCapturedAtISO(
				(payload as { capturedAt?: unknown }).capturedAt,
			);
			const items = (
				await Promise.all(
					payload.variants.map(async (variant) => {
						const blob = await bridge.getCaptureBlob(
							payload.captureID,
							variant.type,
						);
						if (!blob) {
							appendEvent(
								"capture missing blob",
								`${payload.captureID}:${variant.type}`,
							);
							return null;
						}

						return {
							key: `${payload.captureID}:${variant.type}`,
							captureID: payload.captureID,
							type: variant.type,
							url: URL.createObjectURL(blob),
							overlayPluginManifestIDs: variant.overlayPluginManifestIDs,
							capturedAt: capturedAtISO,
						} satisfies CapturePreview;
					}),
				)
			).filter((item) => item != null);

			startTransition(() => {
				setCaptures((current) => {
					const next = [...items, ...current].slice(0, MAX_CAPTURE_PREVIEWS);
					const keep = new Set(next.map((item) => item.key));
					const removed = current.filter((item) => !keep.has(item.key));
					releaseCapturePreviews(removed);
					captureRef.current = next;
					return next;
				});
			});
		},
	);

	useEffect(() => {
		void loadSettings().then(setSettings);

		return subscribeSettings((nextSettings) => {
			setSettings(nextSettings);
		});
	}, []);

	useEffect(() => {
		setPlayables(bridge.getPlayables());
		setStatuses(bridge.getPlayerStatuses());
		setFocusedPlayerID(bridge.getFocusedPlayerID());

		bridge.onPlayablesChange((nextPlayables) => {
			setPlayables(nextPlayables);
			appendEvent("playables", `${nextPlayables.length} item(s)`);
		});

		bridge.onPlayerStatusesChange((nextStatuses) => {
			setStatuses(nextStatuses);
		});

		bridge.onFocusedPlayerIDChange((nextPlayerID) => {
			setFocusedPlayerID(nextPlayerID);
			appendEvent("focus", nextPlayerID ?? "null");
		});

		bridge.onPlayerClosed((playerID) => {
			appendEvent("player closed", playerID);
		});

		bridge.onDeeplinkOpened((payload) => {
			setLastOpenURL(payload);
			appendEvent("deeplink", payload.url);
		});

		bridge.onCaptureTaken((payload) => {
			appendEvent(
				"capture",
				`${payload.captureID} (${payload.variants.length} variants)`,
			);
			void appendCapturePreview(payload);
		});

		return () => {
			releaseCapturePreviews(captureRef.current);
		};
	}, [bridge]);

	const activePlayerID = getActivePlayerID(runtimeInfo, focusedPlayerID);
	const activePlayable = getPlayableByPlayerID(playables, activePlayerID);
	const activeStatus = getStatusByPlayerID(statuses, activePlayerID);

	const updateSettings = useEffectEvent((patch: Partial<ExampleSettings>) => {
		const nextSettings = normalizeSettings({ ...settings, ...patch });
		setSettings(nextSettings);
		void saveSettings(nextSettings);
		appendEvent("settings", JSON.stringify(nextSettings));
	});

	const handleTogglePlayPause = useEffectEvent(() => {
		bridge.togglePlayPause(activePlayerID ?? undefined);
	});

	const handleSeekRelative = useEffectEvent((deltaSeconds: number) => {
		if (
			!activePlayable?.isSeekable ||
			typeof activePlayable.length !== "number" ||
			!activeStatus
		) {
			return;
		}

		const nextTime = Math.max(
			0,
			Math.min(activePlayable.length, activeStatus.time + deltaSeconds),
		);
		const nextPosition =
			activePlayable.length > 0 ? nextTime / activePlayable.length : 0;

		bridge.seek(nextPosition, activePlayerID ?? undefined);
	});

	const handleFetchExampleCom = useEffectEvent(() => {
		setExampleComFetch({ status: "loading" });
		fetch("https://example.com/", { mode: "cors" })
			.then(async (response) => {
				setExampleComFetch({
					status: "success",
					result: {
						status: response.status,
						statusText: response.statusText,
						contentType: response.headers.get("content-type"),
						url: response.url,
						text: await response.text(),
						fetchedAt: new Date().toISOString(),
					},
				});
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				setExampleComFetch({ status: "error", message });
			});
	});

	if (runtimeInfo.displayAreaType === "overlay") {
		return settings.overlayEnabled ? (
			<div className="example-shell is-overlay">
				<PlayerBadge playable={activePlayable} status={activeStatus} />
			</div>
		) : null;
	}

	if (runtimeInfo.displayAreaType === "options") {
		return (
			<OptionsView
				runtimeInfo={runtimeInfo}
				settings={settings}
				onUpdateSettings={updateSettings}
			/>
		);
	}

	return (
		<PanelView
			runtimeInfo={runtimeInfo}
			activePlayerID={activePlayerID}
			activePlayable={activePlayable}
			activeStatus={activeStatus}
			playables={playables}
			statuses={statuses}
			lastOpenURL={lastOpenURL}
			captures={captures}
			eventLog={eventLog}
			settings={settings}
			onTogglePlayPause={handleTogglePlayPause}
			onSeekRelative={handleSeekRelative}
			exampleComFetch={exampleComFetch}
			onFetchExampleCom={handleFetchExampleCom}
			devControls={bridge.__example}
		/>
	);
}
