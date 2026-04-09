import { useEffect, useRef, useState } from "react";
import { initBridge } from "../../kiririn-bridge";
import type {
	DisplayArea,
	Playable,
	PlayerPlaybackState,
} from "../../Plugin.d.ts";
import {
	CommentClient,
	type ConnectionStatus,
	type NiconicoComment,
} from "./comment-client";
import PlayerOverlay from "./components/PlayerOverlay";
import PluginScreen from "./components/PluginScreen";
import PluginSettings from "./components/PluginSettings";
import type { NicoJKContext } from "./context";
import { getJkInfo } from "./definitions";
import { KakologManager } from "./kakolog-manager";

const MAX_COMMENTS = 1000;

export default function App() {
	const [instanceId] = useState(() => Math.random().toString(36).substring(7));
	const [targetPlayable, setTargetPlayable] = useState<Playable | null>(null);
	const [area, setArea] = useState<DisplayArea | null>(null);
	const [comments, setComments] = useState<NiconicoComment[]>([]);
	const [jkContext, setJkContext] = useState<NicoJKContext | null>(null);
	const [playbackState, setPlaybackState] =
		useState<PlayerPlaybackState | null>(null);
	const [wsStatus, setWsStatus] = useState<ConnectionStatus>("disconnected");

	const areaRef = useRef<DisplayArea | null>(null);
	const targetPlayableRef = useRef<Playable | null>(null);
	const playersDataRef = useRef<
		Map<
			string,
			{
				playableId: string | null;
				comments: NiconicoComment[];
				jkId: string | null;
				jkContext: NicoJKContext | null;
			}
		>
	>(new Map());

	const clientsRef = useRef<Map<string, CommentClient>>(new Map());
	const kakologManagersRef = useRef<Map<string, KakologManager>>(new Map());
	const lastPlayableTimesRef = useRef<Map<string, number>>(new Map());

	// Bridge & Background Resources Lifecycle
	useEffect(() => {
		console.log(`[NicoJK][#${instanceId}] App lifecycle start.`);
		const bridge = initBridge();
		if (!bridge) {
			console.error(`[NicoJK][#${instanceId}] Bridge init failed!`);
			return;
		}

		console.log(
			`[NicoJK][#${instanceId}] Initial area:`,
			bridge.getDisplayArea(),
		);
		const initialArea = bridge.getDisplayArea();
		setArea(initialArea);
		areaRef.current = initialArea;

		const updateTarget = () => {
			const currentArea = areaRef.current;
			if (!currentArea) return;

			const tag = currentArea.playerID
				? `[Overlay:${currentArea.playerID}]`
				: "[Screen]";

			let targetP: Playable | null = null;
			let targetS: PlayerPlaybackState | null = null;

			if (currentArea.playerID) {
				targetP = bridge.getPlayable(currentArea.playerID);
				targetS = bridge.getPlayerStatus(currentArea.playerID);
			} else {
				const activeId = bridge.getFocusedPlayerID();
				targetP = activeId ? bridge.getPlayable(activeId) : null;
				targetS = activeId ? bridge.getPlayerStatus(activeId) : null;
			}

			setTargetPlayable(targetP);
			targetPlayableRef.current = targetP;
			setPlaybackState(targetS);

			if (targetP) {
				const data = playersDataRef.current.get(targetP.playerID);
				setComments(data?.comments || []);
				setJkContext(data?.jkContext || null);
				if (data?.jkId) {
					const client = clientsRef.current.get(data.jkId);
					if (client) {
						const currentStatus = client.getStatus();
						console.log(
							`[NicoJK][#${instanceId}]${tag} Sync status with client: ${currentStatus}`,
						);
						setWsStatus(currentStatus);
					}
				}
			} else {
				setComments([]);
				setJkContext(null);
				setWsStatus("disconnected");
			}
		};

		// Subscriptions
		bridge.onFocusedPlayerIDChange((id) => {
			console.log(`[NicoJK][#${instanceId}] Focus event:`, id);
			updateTarget();
		});

		bridge.onPlayablesChange(() => {
			console.log(`[NicoJK][#${instanceId}] Playables change event`);
			updateTarget();
		});

		bridge.onPlayerStatusesChange((statuses) => {
			const currentArea = areaRef.current;
			if (!currentArea) return;
			let s: PlayerPlaybackState | null = null;
			if (currentArea.playerID) {
				s = statuses.find((it) => it.playerID === currentArea.playerID) || null;
			} else {
				const activeId = bridge.getFocusedPlayerID();
				s = activeId
					? statuses.find((it) => it.playerID === activeId) || null
					: null;
			}
			setPlaybackState(s);
		});

		bridge.onDisplayAreaChange((newArea) => {
			console.log(`[NicoJK][#${instanceId}] Area change event:`, newArea.type);
			setArea(newArea);
			areaRef.current = newArea;
			updateTarget();
		});

		bridge.onPlayerClosed((pid) => {
			console.log(`[NicoJK][#${instanceId}] Player closed: ${pid}`);
			playersDataRef.current.delete(pid);
			updateTarget();
		});

		// Initial Target Update
		updateTarget();

		// Background Interval Loop
		const interval = setInterval(() => {
			const playables = bridge.getPlayables();
			const currentArea = areaRef.current;
			if (!currentArea) return;

			// Manage playables based on instance role
			// Overlay instance: Only manage its own target
			// Screen instance: Manage ALL for smooth background switching
			const targetPids = new Set<string>();
			if (currentArea.playerID) {
				targetPids.add(currentArea.playerID);
			} else {
				for (const p of playables) targetPids.add(p.playerID);
			}
			const playablesToManage = playables.filter((p) =>
				targetPids.has(p.playerID),
			);

			for (const p of playablesToManage) {
				if (!playersDataRef.current.has(p.playerID)) {
					playersDataRef.current.set(p.playerID, {
						playableId: p.id,
						comments: [],
						jkId: null,
						jkContext: null,
					});
				}
				const dataObject = playersDataRef.current.get(p.playerID);
				if (!dataObject) continue;
				const data = dataObject;
				const isPassive = !currentArea.playerID;

				// Playable switch detection (same playerID, different content)
				if (data.playableId !== p.id) {
					console.log(
						`[NicoJK][#${instanceId}] Playable switch detected for ${p.playerID}: ${data.playableId} -> ${p.id}`,
					);
					data.playableId = p.id;
					data.comments = [];
					data.jkId = null;
					data.jkContext = null;
					kakologManagersRef.current.delete(p.playerID);
					if (targetPlayableRef.current?.playerID === p.playerID) {
						setComments([]);
						setJkContext(null);
						setWsStatus("disconnected");
					}
				}

				// JkInfo fetch
				if (!data.jkId && p.service?.serviceId) {
					const service = p.service;
					const networkId = service.networkId || 0;
					getJkInfo(service.serviceId, networkId).then((info) => {
						if (info) {
							data.jkId = info.jkId;
							const startAt =
								p.initialNetworkTime || p.program?.startAt || 0;
							const duration = p.length || p.program?.duration || 0;
							data.jkContext = {
								jkId: info.jkId,
								channelName: info.name,
								startAt,
								endAt: startAt + duration,
							};

							if (targetPlayableRef.current?.playerID === p.playerID) {
								setJkContext(data.jkContext);
							}
						}
					});
				}

				// Connection management
				if (data.jkId && !p.isSeekable) {
					if (!clientsRef.current.has(data.jkId)) {
						const client = new CommentClient();
						client.onComment((c) => {
							for (const [pid, pData] of playersDataRef.current.entries()) {
								if (pData.jkId === data.jkId) {
									pData.comments = [...pData.comments, c]
										.sort((a, b) => a.vpos - b.vpos)
										.slice(-MAX_COMMENTS);
									if (targetPlayableRef.current?.playerID === pid) {
										setComments(pData.comments);
									}
								}
							}
						});
						client.onHistoryUpdate((history) => {
							for (const [pid, pData] of playersDataRef.current.entries()) {
								if (pData.jkId === data.jkId) {
									const existingIds = new Set(pData.comments.map((c) => c.id));
									const toAdd = history.filter((o) => !existingIds.has(o.id));
									if (toAdd.length > 0) {
										pData.comments = [...pData.comments, ...toAdd]
											.sort((a, b) => a.vpos - b.vpos)
											.slice(-MAX_COMMENTS);
										if (targetPlayableRef.current?.playerID === pid) {
											setComments(pData.comments);
										}
									}
								}
							}
						});
						client.onStatusUpdate((s) => {
							const currentTarget = targetPlayableRef.current;
							if (currentTarget) {
								const currentData = playersDataRef.current.get(
									currentTarget.playerID,
								);
								if (currentData?.jkId === data.jkId) {
									setWsStatus(s);
								}
							}
						});
						client.connect(data.jkId, { passive: isPassive });
						clientsRef.current.set(data.jkId, client);
					}
				}

				// Kakolog fetch
				if (data.jkId && p.isSeekable) {
					if (!kakologManagersRef.current.has(p.playerID)) {
						const mgr = new KakologManager();
						mgr.setJkId(data.jkId);
						kakologManagersRef.current.set(p.playerID, mgr);
					}
					const mgr = kakologManagersRef.current.get(p.playerID);
					const status = bridge.getPlayerStatus(p.playerID);
					if (mgr && status) {
						const startAt =
							p.initialNetworkTime || p.program?.startAt || 0;
						const duration = p.length || p.program?.duration || 0;

						mgr
							.fetchIfNeeded(startAt, status.time, duration)
							.then((newOnes) => {
								if (newOnes && newOnes.length > 0) {
									const existingIds = new Set(data.comments.map((c) => c.id));
									const toAdd = newOnes.filter((o) => !existingIds.has(o.id));
									if (toAdd.length > 0) {
										data.comments = [...data.comments, ...toAdd].sort(
											(a, b) => a.vpos - b.vpos,
										);

										// Broadcast past comments to passive instances
										const jkId = data.jkId;
										if (jkId) {
											const client = clientsRef.current.get(jkId);
											if (client && !isPassive) {
												client.broadcastHistory(toAdd);
											}
										}

										if (targetPlayableRef.current?.playerID === p.playerID) {
											setComments(data.comments);
										}
									}
								}
							});
					}
				}
			}

			// Garbage collection
			const activeJkIds = new Set(
				playables
					.map((p) => playersDataRef.current.get(p.playerID)?.jkId)
					.filter(Boolean),
			);
			for (const [jkId, client] of clientsRef.current.entries()) {
				if (!activeJkIds.has(jkId)) {
					client.disconnect();
					clientsRef.current.delete(jkId);
				}
			}
			const activePids = new Set(playables.map((p) => p.playerID));
			for (const pid of kakologManagersRef.current.keys()) {
				if (!activePids.has(pid)) kakologManagersRef.current.delete(pid);
			}
		}, 2000);

		return () => {
			console.log(`[NicoJK][#${instanceId}] App lifecycle cleanup.`);
			clearInterval(interval);
			for (const client of clientsRef.current.values()) client.disconnect();
			clientsRef.current.clear();
		};
	}, [instanceId]);

	if (!area) return null;

	return (
		<div className="w-full h-full relative overflow-hidden font-sans">
			{area.type === "playerOverlay" && (
				<PlayerOverlay
					comments={comments}
					width={area.width}
					height={area.height}
					isLive={!targetPlayable?.isSeekable}
					playbackState={playbackState}
					jkContext={jkContext}
				/>
			)}

			{area.type === "pluginScreen" && (
				<PluginScreen
					comments={comments}
					isLive={!!targetPlayable && !targetPlayable.isSeekable}
					playbackState={playbackState}
					wsStatus={wsStatus}
					jkContext={jkContext}
					hasActivePlayer={!!targetPlayable}
				/>
			)}

			{area.type === "pluginSettings" && <PluginSettings />}

			{/* Debug UI for MockBridge */}
			{typeof window !== "undefined" &&
				(window.kiririn as any)?.toggleSeekable && (
					<div className="fixed bottom-4 left-4 z-[9999] flex flex-col gap-2 p-2 bg-black/80 rounded-lg border border-gray-600 shadow-2xl backdrop-blur-sm max-w-sm">
						<div className="text-[10px] text-gray-400 font-mono flex justify-between">
							<span>MockBridge Controls</span>
							<span className="text-blue-400 text-[8px] opacity-70">
								instanceId: {instanceId}
							</span>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => (window.kiririn as any).toggleSeekable()}
								className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-[10px] rounded"
							>
								Toggle Seekable
							</button>
							<button
								type="button"
								onClick={() => (window.kiririn as any).nextAreaPattern()}
								className="px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white text-[10px] rounded"
							>
								Next Area
							</button>
						</div>
						<div className="flex flex-col gap-1 b border-t border-gray-700 pt-1">
							<div className="text-[8px] text-gray-500">Active Players:</div>
							<div className="flex gap-1 overflow-x-auto">
								{(window.kiririn as any).getPlayables().map((p: any) => (
									<div key={p.playerID} className="flex flex-col gap-1">
										<button
											type="button"
											onClick={() =>
												(window.kiririn as any).focusPlayable(p.playerID)
											}
											className={`px-2 py-1 text-[8px] rounded truncate max-w-[80px] ${
												targetPlayable?.playerID === p.playerID
													? "bg-green-600 text-white"
													: "bg-gray-700 text-gray-300"
											}`}
										>
											Focus {p.playerID.substring(0, 4)}
										</button>
										<button
											type="button"
											onClick={() =>
												(window.kiririn as any).closePlayer(p.playerID)
											}
											className="px-2 py-0.5 bg-red-900/50 hover:bg-red-800 text-red-200 text-[8px] rounded"
										>
											Close
										</button>
									</div>
								))}
							</div>
						</div>
					</div>
				)}
		</div>
	);
}
