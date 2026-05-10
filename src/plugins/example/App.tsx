import { useEffect, useState } from "react";
import { initBridge } from "../../kiririn-bridge";
import type {
	DisplayArea,
	Playable,
	PlayerPlaybackState,
} from "../../Plugin.d.ts";

const SETTINGS_STORAGE_KEY = "kiririn-example-settings";

type ExampleSettings = {
	showOverlay: boolean;
};

const DEFAULT_SETTINGS: ExampleSettings = {
	showOverlay: true,
};

function loadSettings(): ExampleSettings {
	const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
	if (!raw) {
		return DEFAULT_SETTINGS;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<ExampleSettings>;
		return {
			showOverlay:
				typeof parsed.showOverlay === "boolean"
					? parsed.showOverlay
					: DEFAULT_SETTINGS.showOverlay,
		};
	} catch {
		return DEFAULT_SETTINGS;
	}
}

function saveSettings(settings: ExampleSettings) {
	localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function formatUnixTime(unixTime?: number) {
	if (!unixTime) {
		return "-";
	}
	return new Date(unixTime * 1000).toLocaleString();
}

function formatSeconds(seconds?: number) {
	if (typeof seconds !== "number") {
		return "-";
	}
	return `${seconds}s`;
}

function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="mt-2 overflow-x-auto rounded border border-gray-700 bg-gray-950 p-3 text-xs leading-relaxed text-gray-200">
			{JSON.stringify(value, null, 2)}
		</pre>
	);
}

function FieldRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-3 border-b border-gray-800 py-2 text-sm">
			<div className="text-gray-400">{label}</div>
			<div className="break-words text-gray-100">{value}</div>
		</div>
	);
}

function PluginScreenView({
	area,
	focusedPlayerID,
	playable,
	playbackState,
}: {
	area: DisplayArea;
	focusedPlayerID: string | null;
	playable: Playable | null;
	playbackState: PlayerPlaybackState | null;
}) {
	if (!playable) {
		return (
			<div className="h-full overflow-y-auto bg-gray-950 p-6 text-gray-100">
				<h1 className="text-2xl font-bold">PluginScreen Example</h1>
				<p className="mt-3 text-sm text-gray-300">
					focused player
					がありません。プレイヤーを選択するとメディア情報を表示します。
				</p>
				<div className="mt-5 rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-300">
					<div>focusedPlayerID: {focusedPlayerID ?? "(null)"}</div>
					<div>
						displayArea: {area.type} ({area.width} x {area.height})
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full overflow-y-auto bg-gray-950 p-6 text-gray-100">
			<h1 className="text-2xl font-bold">PluginScreen Example</h1>
			<p className="mt-2 text-sm text-gray-300">メディア情報</p>

			<section className="mt-6 rounded border border-gray-800 bg-gray-900 p-4">
				<h2 className="mb-1 text-base font-semibold">Playable</h2>
				<FieldRow label="playerID" value={playable.playerID} />
				<FieldRow label="id" value={playable.id} />
				<FieldRow label="title" value={playable.title} />
				<FieldRow label="subtitle" value={playable.subtitle ?? "-"} />
				<FieldRow
					label="initialNetworkTime"
					value={`${playable.initialNetworkTime ?? "-"} (${formatUnixTime(playable.initialNetworkTime)})`}
				/>
				<FieldRow label="isSeekable" value={String(playable.isSeekable)} />
				<FieldRow label="length" value={formatSeconds(playable.length)} />
			</section>

			<section className="mt-4 rounded border border-gray-800 bg-gray-900 p-4">
				<h2 className="mb-1 text-base font-semibold">Program</h2>
				{playable.program ? (
					<>
						<FieldRow label="name" value={playable.program.name} />
						<FieldRow
							label="description"
							value={playable.program.description || "-"}
						/>
						<FieldRow
							label="startAt"
							value={`${playable.program.startAt} (${formatUnixTime(playable.program.startAt)})`}
						/>
						<FieldRow
							label="endAt"
							value={`${playable.program.endAt} (${formatUnixTime(playable.program.endAt)})`}
						/>
						<FieldRow
							label="duration"
							value={formatSeconds(playable.program.duration)}
						/>
						<FieldRow
							label="eventId"
							value={String(playable.program.eventId ?? "-")}
						/>
						<FieldRow
							label="extended"
							value={`${playable.program.extended.length} item(s)`}
						/>
						<FieldRow
							label="genres"
							value={`${playable.program.genres.length} item(s)`}
						/>
						<JsonBlock value={playable.program} />
					</>
				) : (
					<p className="text-sm text-gray-300">program: -</p>
				)}
			</section>

			<section className="mt-4 rounded border border-gray-800 bg-gray-900 p-4">
				<h2 className="mb-1 text-base font-semibold">Service</h2>
				{playable.service ? (
					<>
						<FieldRow label="name" value={playable.service.name} />
						<FieldRow
							label="serviceId"
							value={String(playable.service.serviceId)}
						/>
						<FieldRow
							label="networkId"
							value={String(playable.service.networkId)}
						/>
						<FieldRow
							label="type.value"
							value={String(playable.service.type.value)}
						/>
						<FieldRow
							label="type.description"
							value={playable.service.type.description}
						/>
						<FieldRow
							label="channel.id"
							value={playable.service.channel?.id ?? "-"}
						/>
						<FieldRow
							label="channel.type"
							value={playable.service.channel?.type ?? "-"}
						/>
						<JsonBlock value={playable.service} />
					</>
				) : (
					<p className="text-sm text-gray-300">service: -</p>
				)}
			</section>

			<section className="mt-4 rounded border border-gray-800 bg-gray-900 p-4">
				<h2 className="mb-1 text-base font-semibold">Playback State</h2>
				{playbackState ? (
					<>
						<FieldRow label="playerID" value={playbackState.playerID} />
						<FieldRow label="playableID" value={playbackState.playableID} />
						<FieldRow
							label="isPlaying"
							value={String(playbackState.isPlaying)}
						/>
						<FieldRow label="time" value={formatSeconds(playbackState.time)} />
						<FieldRow label="position" value={String(playbackState.position)} />
						<JsonBlock value={playbackState} />
					</>
				) : (
					<p className="text-sm text-gray-300">playbackState: -</p>
				)}
			</section>

			<section className="mt-4 rounded border border-gray-800 bg-gray-900 p-4">
				<h2 className="mb-1 text-base font-semibold">Raw JSON</h2>
				<p className="text-sm text-gray-300">
					将来フィールド追加時の取りこぼし確認用です。
				</p>
				<JsonBlock
					value={{
						focusedPlayerID,
						playable,
						playbackState,
						displayArea: area,
					}}
				/>
			</section>
		</div>
	);
}

function PlayerOverlayView({ title }: { title: string | null }) {
	return (
		<div className="inline-flex max-w-[220px] flex-col gap-0.5 rounded bg-black/65 px-2 py-1 text-[10px] text-white">
			<span className="font-semibold">Example Plugin active</span>
			<span className="truncate text-gray-200">{title ?? "No media"}</span>
		</div>
	);
}

function PluginSettingsView({
	onSettingsChange,
}: {
	onSettingsChange: (settings: ExampleSettings) => void;
}) {
	const [settings, setSettings] = useState<ExampleSettings>(() =>
		loadSettings(),
	);

	const handleToggleOverlay = (checked: boolean) => {
		const next = { showOverlay: checked };
		saveSettings(next);
		setSettings(next);
		onSettingsChange(next);
	};

	return (
		<div className="h-full overflow-y-auto bg-gray-950 p-6 text-gray-100">
			<h1 className="text-lg font-semibold">Example Settings</h1>
			<p className="mt-2 text-sm text-gray-300">保存済みの表示設定です。</p>

			<div className="mt-4 max-w-xl rounded border border-gray-800 bg-gray-900 p-4">
				<label
					htmlFor="example-show-overlay"
					className="flex items-center gap-3 text-sm text-gray-200"
				>
					<input
						id="example-show-overlay"
						type="checkbox"
						checked={settings.showOverlay}
						onChange={(e) => handleToggleOverlay(e.target.checked)}
						className="h-4 w-4"
					/>
					PlayerOverlay に表示する
				</label>
				<div className="mt-4 text-sm text-gray-200">
					保存済み値: {settings.showOverlay ? "ON" : "OFF"}
				</div>
			</div>
		</div>
	);
}

function App() {
	const [settings, setSettings] = useState<ExampleSettings>(() =>
		loadSettings(),
	);
	const [focusedPlayerID, setFocusedPlayerID] = useState<string | null>(null);
	const [playable, setPlayable] = useState<Playable | null>(null);
	const [playbackState, setPlaybackState] =
		useState<PlayerPlaybackState | null>(null);
	const [area, setArea] = useState<DisplayArea | null>(null);
	const debugKiririn = window.kiririn as typeof window.kiririn & {
		nextAreaPattern?: () => void;
	};

	useEffect(() => {
		setSettings(loadSettings());

		const handleStorage = (event: StorageEvent) => {
			if (event.key === SETTINGS_STORAGE_KEY) {
				setSettings(loadSettings());
			}
		};

		window.addEventListener("storage", handleStorage);

		const bridge = initBridge();
		if (!bridge) {
			window.removeEventListener("storage", handleStorage);
			return;
		}

		const update = () => {
			const currentArea = bridge.getDisplayArea();
			setArea(currentArea);

			const currentFocusedPlayerID = bridge.getFocusedPlayerID();
			setFocusedPlayerID(currentFocusedPlayerID);

			const targetPlayerID = currentArea.playerID || currentFocusedPlayerID;
			if (!targetPlayerID) {
				setPlayable(null);
				setPlaybackState(null);
				return;
			}

			setPlayable(bridge.getPlayable(targetPlayerID));
			setPlaybackState(bridge.getPlayerStatus(targetPlayerID));
		};

		update();
		bridge.onDisplayAreaChange(update);
		bridge.onPlayablesChange(update);
		bridge.onFocusedPlayerIDChange(update);
		bridge.onPlayerStatusesChange(update);
		bridge.onPlayerClosed(update);

		return () => {
			window.removeEventListener("storage", handleStorage);
		};
	}, []);

	if (!area) {
		return <div className="bg-black/50 p-5 text-white">読み込み中...</div>;
	}

	return (
		<div className="relative h-full w-full bg-transparent">
			{area.type === "pluginScreen" && (
				<PluginScreenView
					area={area}
					focusedPlayerID={focusedPlayerID}
					playable={playable}
					playbackState={playbackState}
				/>
			)}

			{area.type === "playerOverlay" && settings.showOverlay && (
				<div className="p-2">
					<PlayerOverlayView title={playable?.title ?? null} />
				</div>
			)}

			{area.type === "pluginSettings" && (
				<PluginSettingsView onSettingsChange={setSettings} />
			)}

			{typeof debugKiririn.nextAreaPattern === "function" && (
				<button
					type="button"
					onClick={() => debugKiririn.nextAreaPattern?.()}
					className="absolute right-3 top-3 z-50 rounded bg-sky-700 px-2 py-1 text-[10px] font-semibold text-white hover:bg-sky-600"
				>
					Switch Area
				</button>
			)}
		</div>
	);
}

export default App;
