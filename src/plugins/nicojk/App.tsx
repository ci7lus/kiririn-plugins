import { useEffect, useRef, useState } from "react";
import { initBridge } from "../../kiririn-bridge";
import type {
	DisplayArea,
	Playable,
	PlayerPlaybackState,
} from "../../Plugin.d.ts";
import { CommentClient, type NiconicoComment } from "./comment-client";
import PlayerOverlay from "./components/PlayerOverlay";
import PluginScreen from "./components/PluginScreen";
import PluginSettings from "./components/PluginSettings";
import type { NicoJKContext } from "./context";
import { getJkInfo } from "./definitions";
import { KakologManager } from "./kakolog-manager";

const MAX_COMMENTS = 500;

export default function App() {
	const [playable, setPlayable] = useState<Playable | null>(null);
	const [area, setArea] = useState<DisplayArea | null>(null);
	const [comments, setComments] = useState<NiconicoComment[]>([]);
	const [jkId, setJkId] = useState<string | null>(null);
	const [jkContext, setJkContext] = useState<NicoJKContext | null>(null);
	const [playbackState, setPlaybackState] =
		useState<PlayerPlaybackState | null>(null);
	const [wsStatus, setWsStatus] = useState<string>("disconnected");
	const lastVideoIdRef = useRef<string | null>(null);

	const clientRef = useRef<CommentClient>(new CommentClient());
	const kakologRef = useRef<KakologManager>(new KakologManager());
	const lastModeRef = useRef<"live" | "kakolog" | null>(null);

	// Bridge Init & Event Subscription (once on mount)
	useEffect(() => {
		const bridge = initBridge();

		const unsubPlayable = bridge.onPlayableUpdate(async (p) => {
			setPlayable(p);
			const serviceId = p.service?.serviceId;
			const networkId = p.service?.networkId;
			if (serviceId && networkId) {
				const info = await getJkInfo(serviceId, networkId);
				if (info) {
					setJkId(info.jkId);
					const startAt =
						(p.firstNetworkTime || 0) - 4 || p.program?.startAt || 0;
					const duration = p.program?.duration || p.length || 0;
					setJkContext({
						jkId: info.jkId,
						channelName: info.name,
						startAt,
						endAt: startAt + duration,
					});
				} else {
					setJkId(null);
					setJkContext(null);
				}
			} else {
				setJkId(null);
				setJkContext(null);
			}
		});

		const unsubArea = bridge.onDisplayAreaUpdate(setArea);
		const unsubStatus = clientRef.current.onStatusUpdate(setWsStatus);

		const unsubComment = clientRef.current.onComment((c) => {
			const currentPlayable = window.kiririn.getPlayable();
			setComments((prev) => {
				const next = [...prev, c];
				// Liveモードのみ500件制限。過去ログ時は制限なし
				if (!currentPlayable?.isSeekable && next.length > MAX_COMMENTS) {
					return next.slice(next.length - MAX_COMMENTS);
				}
				return next;
			});
		});

		const unsubHistory = clientRef.current.onHistoryUpdate((history) => {
			setComments(history);
		});

		return () => {
			unsubPlayable?.();
			unsubArea?.();
			unsubStatus?.();
			unsubComment?.();
			unsubHistory?.();
			clientRef.current.disconnect();
		};
	}, []);

	// Connection & Mode Management (Triggered by jkId / isSeekable change)
	useEffect(() => {
		const bridge = window.kiririn;
		if (!bridge || !playable) return;

		const targetMode = playable.isSeekable ? "kakolog" : "live";
		const isModeChanged = lastModeRef.current !== targetMode;
		const isVideoChanged = lastVideoIdRef.current !== playable.id;

		if (isVideoChanged) {
			console.log(
				`[NicoJK] Video changed to ${playable.id}. Clearing comments.`,
			);
			setComments([]);
			lastVideoIdRef.current = playable.id;
		}

		if (targetMode === "live") {
			// Live Mode
			if (isModeChanged || isVideoChanged) {
				console.log(`[NicoJK] Entering Live mode for ${jkId}`);
				lastModeRef.current = "live";
				setComments([]); // Clear kakolog comments when entering live
			}
			if (jkId) {
				clientRef.current.connect(jkId);
			} else {
				clientRef.current.disconnect();
			}
			kakologRef.current.clear();
		} else {
			// Kakolog Mode
			if (isModeChanged || isVideoChanged) {
				console.log(`[NicoJK] Entering Kakolog mode for ${jkId}`);
				lastModeRef.current = "kakolog";
				clientRef.current.disconnect();
				setComments([]);
				if (jkId) {
					kakologRef.current.setJkId(jkId);
				}
			}
		}
	}, [jkId, playable?.isSeekable, playable?.id, playable]);

	// Kakolog Fetcher Logic
	useEffect(() => {
		const bridge = window.kiririn;
		if (!bridge) return;

		let lastFetchTime = 0;
		let lastTime = -1;

		const unsubState = bridge.onPlayerStateUpdate((state) => {
			setPlaybackState(state);
			const currentPlayable = window.kiririn.getPlayable();
			if (currentPlayable?.isSeekable && jkId) {
				// シーク戻り検知
				if (state.time < lastTime) {
					setComments([]);
				}
				lastTime = state.time;

				const startAt =
					(currentPlayable?.firstNetworkTime || 0) - 4 ||
					currentPlayable?.program?.startAt ||
					0;
				const duration =
					currentPlayable?.program?.duration || currentPlayable?.length || 0;

				// 5秒おきにフェッチ確認
				if (Date.now() - lastFetchTime > 5000) {
					kakologRef.current
						.fetchIfNeeded(startAt, state.time, duration)
						.then((newOnes) => {
							if (newOnes.length > 0) {
								setComments((prev) => {
									const existingIds = new Set(prev.map((p) => p.id));
									const toAdd = newOnes.filter((o) => !existingIds.has(o.id));
									if (toAdd.length === 0) return prev;
									return [...prev, ...toAdd];
								});
							}
						});
					lastFetchTime = Date.now();
				}
			}
		});

		return () => {
			unsubState?.();
		};
	}, [jkId]);

	if (!area) return null;

	return (
		<div className="w-full h-full relative overflow-hidden font-sans">
			{area.type === "playerOverlay" && (
				<PlayerOverlay
					comments={comments}
					width={area.width}
					height={area.height}
					isLive={!playable?.isSeekable}
					playbackState={playbackState}
					jkContext={jkContext}
				/>
			)}

			{area.type === "pluginScreen" && (
				<PluginScreen
					comments={comments}
					isLive={!playable?.isSeekable}
					playbackState={playbackState}
					wsStatus={wsStatus}
					jkContext={jkContext}
				/>
			)}

			{area.type === "pluginSettings" && <PluginSettings />}

			{/* Debug UI for MockBridge */}
			{typeof window !== "undefined" &&
				(window.kiririn as any)?.toggleSeekable && (
					<div className="fixed bottom-4 left-4 z-[9999] flex flex-col gap-2 p-2 bg-black/80 rounded-lg border border-gray-600 shadow-2xl backdrop-blur-sm">
						<div className="absolute top-0 right-0 bg-black/50 text-[10px] p-1 pointer-events-none">
							{jkId} {wsStatus}
						</div>
						<div className="text-[10px] font-bold text-gray-400 px-1">
							DEBUG CONTROLS
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => (window.kiririn as any).nextAreaPattern()}
								className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition-colors"
							>
								Area Switch
							</button>
							<button
								type="button"
								onClick={() => (window.kiririn as any).toggleSeekable()}
								className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition-colors"
							>
								{playable?.isSeekable ? "Live" : "Kakolog"} Mode
							</button>
						</div>
					</div>
				)}
		</div>
	);
}
