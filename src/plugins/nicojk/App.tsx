import { useEffect, useRef, useState } from "react";
import { initBridge } from "../../kiririn-bridge";
import type {
	DisplayArea,
	KiririnBridge,
	Playable,
	PlayerPlaybackState,
} from "../../Plugin.d.ts";
import {
	CommentClient,
	type ConnectionStatus,
	type NiconicoComment,
} from "./comment-client";
import { buildStableCommentId } from "./comment-id";
import PlayerOverlay from "./components/PlayerOverlay";
import PluginScreen from "./components/PluginScreen";
import PluginSettings from "./components/PluginSettings";
import type { NicoJKContext, NicoJKSourceContext } from "./context";
import {
	getChannelDefinition,
	type NicoJKChannelDefinition,
} from "./definitions";
import { KakologManager } from "./kakolog-manager";
import {
	type ResolvedCommentSource,
	type ResolvedCommentSources,
	resolveCommentSources,
} from "./source-resolver";

const MAX_LIVE_COMMENTS = 1000;
const PLAYER_OVERLAY_RELAY_PREFIX = "nicojk_overlay_player_";

type PlayerData = {
	playableId: string | null;
	comments: NiconicoComment[];
	primaryChannel: NicoJKChannelDefinition | null;
	liveSources: ResolvedCommentSource[];
	replaySources: ResolvedCommentSource[];
	jkContext: NicoJKContext | null;
	channelLookupKey: string | null;
	sourceResolutionKey: string | null;
	isResolvingSources: boolean;
	sourceResolutionToken: number;
};

function createPlayerData(playableId: string | null): PlayerData {
	return {
		playableId,
		comments: [],
		primaryChannel: null,
		liveSources: [],
		replaySources: [],
		jkContext: null,
		channelLookupKey: null,
		sourceResolutionKey: null,
		isResolvingSources: false,
		sourceResolutionToken: 0,
	};
}

function getBaseTiming(playable: Playable) {
	const startAt = playable.initialNetworkTime || playable.program?.startAt || 0;
	const duration = playable.length || playable.program?.duration || 0;
	return { startAt, duration };
}

function getProgramResolutionSignature(playable: Playable) {
	return [
		playable.program?.eventId || "",
		playable.program?.name || "",
		playable.title || "",
		playable.subtitle || "",
	].join(":");
}

function buildPrimarySource(
	channel: NicoJKChannelDefinition,
	startAt: number,
	duration: number,
): ResolvedCommentSource | null {
	if (!channel.jkId) {
		return null;
	}

	return {
		key: `primary:${channel.jkId}:${channel.syobocalId || "na"}:${startAt}`,
		kind: "primary",
		jkId: channel.jkId,
		channelName: channel.name,
		syobocalId: channel.syobocalId,
		startAt,
		endAt: startAt + duration,
	};
}

function toContextSource(source: ResolvedCommentSource): NicoJKSourceContext {
	return {
		key: source.key,
		jkId: source.jkId,
		channelName: source.channelName,
		kind: source.kind,
		startAt: source.startAt,
		endAt: source.endAt,
	};
}

function buildJkContext(
	primarySource: ResolvedCommentSource,
	sources: ResolvedCommentSource[],
	startAt: number,
	duration: number,
): NicoJKContext {
	return {
		jkId: primarySource.jkId,
		channelName: primarySource.channelName,
		startAt,
		endAt: startAt + duration,
		sources: sources.map(toContextSource),
	};
}

function applyPrimarySource(
	data: PlayerData,
	primarySource: ResolvedCommentSource,
	startAt: number,
	duration: number,
) {
	data.liveSources = [primarySource];
	data.replaySources = [primarySource];
	data.jkContext = buildJkContext(
		primarySource,
		[primarySource],
		startAt,
		duration,
	);
}

function applyResolvedSources(
	data: PlayerData,
	resolved: ResolvedCommentSources,
	isSeekable: boolean,
	startAt: number,
	duration: number,
) {
	data.liveSources = [resolved.primary, ...resolved.liveSources];
	data.replaySources = isSeekable
		? [resolved.primary, ...resolved.replaySources]
		: [resolved.primary];
	data.jkContext = buildJkContext(
		resolved.primary,
		isSeekable ? data.replaySources : data.liveSources,
		startAt,
		duration,
	);
}

function aggregateConnectionStatuses(
	statuses: ConnectionStatus[],
): ConnectionStatus {
	if (statuses.some((status) => status === "connected")) {
		return "connected";
	}
	if (statuses.some((status) => status === "connecting")) {
		return "connecting";
	}
	if (statuses.some((status) => status === "error")) {
		return "error";
	}
	return "disconnected";
}

function getSourceOrdinal(sources: ResolvedCommentSource[], jkId: string) {
	const index = sources.findIndex((source) => source.jkId === jkId);
	return index < 0 ? 0 : index;
}

function scopeLiveComment(
	comment: NiconicoComment,
	sourceOrdinal: number,
): NiconicoComment {
	return {
		...comment,
		id: buildStableCommentId({
			seconds: comment.date,
			microseconds: comment.date_usec,
			no: comment.no,
			sourceOrdinal,
		}),
	};
}

function mergeComments(
	existing: NiconicoComment[],
	incoming: NiconicoComment[],
	maxCount?: number,
): NiconicoComment[] {
	if (incoming.length === 0) {
		return existing;
	}

	const merged = [...existing, ...incoming].sort(
		(a, b) =>
			a.vpos - b.vpos ||
			a.date - b.date ||
			a.date_usec - b.date_usec ||
			a.id - b.id,
	);
	const deduped: NiconicoComment[] = [];
	const seen = new Set<number>();
	for (const comment of merged) {
		if (seen.has(comment.id)) {
			continue;
		}
		seen.add(comment.id);
		deduped.push(comment);
	}

	return typeof maxCount === "number" ? deduped.slice(-maxCount) : deduped;
}

interface PlayerOverlaySnapshot {
	playerID: string;
	playableId: string | null;
	comments: NiconicoComment[];
	jkContext: NicoJKContext | null;
	wsStatus: ConnectionStatus;
	isLive: boolean;
}

type PlayerOverlayRelayMessage =
	| { type: "requestSnapshot" }
	| { type: "snapshot"; payload: PlayerOverlaySnapshot };

function createPlayerOverlayRelayChannel(playerID: string) {
	return new BroadcastChannel(`${PLAYER_OVERLAY_RELAY_PREFIX}${playerID}`);
}

type DebugKiririnBridge = KiririnBridge & {
	toggleSeekable?: () => void;
	nextAreaPattern?: () => void;
	focusPlayable?: (playerID: string) => void;
	closePlayer?: (playerID: string) => void;
};

export default function App() {
	const [instanceId] = useState(() => Math.random().toString(36).substring(7));
	const [targetPlayable, setTargetPlayable] = useState<Playable | null>(null);
	const [area, setArea] = useState<DisplayArea | null>(null);
	const [comments, setComments] = useState<NiconicoComment[]>([]);
	const [jkContext, setJkContext] = useState<NicoJKContext | null>(null);
	const [playbackState, setPlaybackState] =
		useState<PlayerPlaybackState | null>(null);
	const [wsStatus, setWsStatus] = useState<ConnectionStatus>("disconnected");
	const [screenIsLive, setScreenIsLive] = useState(false);

	const areaRef = useRef<DisplayArea | null>(null);
	const targetPlayableRef = useRef<Playable | null>(null);
	const relayChannelRef = useRef<BroadcastChannel | null>(null);
	const commentsRef = useRef<NiconicoComment[]>([]);
	const jkContextRef = useRef<NicoJKContext | null>(null);
	const wsStatusRef = useRef<ConnectionStatus>("disconnected");
	const overlayIsLiveRef = useRef(false);
	const playersDataRef = useRef<Map<string, PlayerData>>(new Map());

	const clientsRef = useRef<Map<string, CommentClient>>(new Map());
	const kakologManagersRef = useRef<Map<string, KakologManager>>(new Map());

	useEffect(() => {
		commentsRef.current = comments;
	}, [comments]);

	useEffect(() => {
		jkContextRef.current = jkContext;
	}, [jkContext]);

	useEffect(() => {
		wsStatusRef.current = wsStatus;
	}, [wsStatus]);

	useEffect(() => {
		overlayIsLiveRef.current = !targetPlayable?.isSeekable;
	}, [targetPlayable?.isSeekable]);

	useEffect(() => {
		if (area?.type !== "playerOverlay" || !area.playerID) return;
		const playerID = area.playerID;

		const channel = createPlayerOverlayRelayChannel(playerID);
		const postSnapshot = () => {
			channel.postMessage({
				type: "snapshot",
				payload: {
					playerID,
					playableId: targetPlayableRef.current?.id || null,
					comments: commentsRef.current,
					jkContext: jkContextRef.current,
					wsStatus: wsStatusRef.current,
					isLive: overlayIsLiveRef.current,
				},
			} satisfies PlayerOverlayRelayMessage);
		};
		channel.onmessage = (event: MessageEvent<PlayerOverlayRelayMessage>) => {
			if (event.data.type === "requestSnapshot") {
				postSnapshot();
			}
		};
		relayChannelRef.current = channel;
		postSnapshot();

		return () => {
			channel.onmessage = null;
			channel.close();
			if (relayChannelRef.current === channel) {
				relayChannelRef.current = null;
			}
		};
	}, [area?.type, area?.playerID]);

	useEffect(() => {
		if (area?.type !== "playerOverlay" || !area.playerID) return;
		const channel = relayChannelRef.current;
		if (!channel) return;

		channel.postMessage({
			type: "snapshot",
			payload: {
				playerID: area.playerID,
				playableId: targetPlayable?.id || null,
				comments,
				jkContext,
				wsStatus,
				isLive: !targetPlayable?.isSeekable,
			},
		} satisfies PlayerOverlayRelayMessage);
	}, [
		area?.type,
		area?.playerID,
		comments,
		jkContext,
		wsStatus,
		targetPlayable?.id,
		targetPlayable?.isSeekable,
	]);

	useEffect(() => {
		if (area?.type !== "pluginScreen") return;

		const playerID = targetPlayable?.playerID;
		const expectedPlayableId = targetPlayable?.id || null;

		setComments([]);
		setJkContext(null);
		setWsStatus("disconnected");
		setScreenIsLive(false);

		if (!playerID) return;

		const channel = createPlayerOverlayRelayChannel(playerID);
		channel.onmessage = (event: MessageEvent<PlayerOverlayRelayMessage>) => {
			if (event.data.type !== "snapshot") return;
			if (
				expectedPlayableId &&
				event.data.payload.playableId &&
				event.data.payload.playableId !== expectedPlayableId
			) {
				return;
			}

			setComments(event.data.payload.comments);
			setJkContext(event.data.payload.jkContext);
			setWsStatus(event.data.payload.wsStatus);
			setScreenIsLive(event.data.payload.isLive);
		};
		channel.postMessage({
			type: "requestSnapshot",
		} satisfies PlayerOverlayRelayMessage);

		return () => {
			channel.onmessage = null;
			channel.close();
		};
	}, [area?.type, targetPlayable?.playerID, targetPlayable?.id]);

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

		const getPlayerWsStatus = (data?: PlayerData): ConnectionStatus => {
			if (!data || data.liveSources.length === 0) {
				return "disconnected";
			}
			return aggregateConnectionStatuses(
				data.liveSources.map(
					(source) =>
						clientsRef.current.get(source.jkId)?.getStatus() || "disconnected",
				),
			);
		};

		const syncTargetState = (playerID: string) => {
			if (targetPlayableRef.current?.playerID !== playerID) return;
			const data = playersDataRef.current.get(playerID);
			setComments(data?.comments || []);
			setJkContext(data?.jkContext || null);
			setWsStatus(getPlayerWsStatus(data));
		};

		const updateTarget = () => {
			const currentArea = areaRef.current;
			if (!currentArea) return;

			let targetP: Playable | null = null;
			let targetS: PlayerPlaybackState | null = null;

			if (currentArea.type === "playerOverlay" && currentArea.playerID) {
				targetP = bridge.getPlayable(currentArea.playerID);
				targetS = bridge.getPlayerStatus(currentArea.playerID);
			} else if (currentArea.type === "pluginScreen") {
				const activeId = bridge.getFocusedPlayerID();
				targetP = activeId ? bridge.getPlayable(activeId) : null;
				targetS = activeId ? bridge.getPlayerStatus(activeId) : null;
			} else {
				setTargetPlayable(null);
				targetPlayableRef.current = null;
				setPlaybackState(null);
				setComments([]);
				setJkContext(null);
				setWsStatus("disconnected");
				setScreenIsLive(false);
				return;
			}

			setTargetPlayable(targetP);
			targetPlayableRef.current = targetP;
			setPlaybackState(targetS);

			if (currentArea.type === "playerOverlay" && targetP) {
				const data = playersDataRef.current.get(targetP.playerID);
				setComments(data?.comments || []);
				setJkContext(data?.jkContext || null);
				setWsStatus(getPlayerWsStatus(data));
			} else {
				setComments([]);
				setJkContext(null);
				setWsStatus("disconnected");
				setScreenIsLive(false);
			}
		};

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
			if (currentArea.type === "pluginSettings") {
				setPlaybackState(null);
				return;
			}
			let s: PlayerPlaybackState | null = null;
			if (currentArea.type === "playerOverlay" && currentArea.playerID) {
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

		updateTarget();

		const interval = setInterval(() => {
			const playables = bridge.getPlayables();
			const currentArea = areaRef.current;
			if (!currentArea) return;
			if (currentArea.type !== "playerOverlay" || !currentArea.playerID) {
				return;
			}

			const playablesToManage = playables.filter(
				(p) => p.playerID === currentArea.playerID,
			);

			for (const p of playablesToManage) {
				if (!playersDataRef.current.has(p.playerID)) {
					playersDataRef.current.set(p.playerID, createPlayerData(p.id));
				}
				const dataObject = playersDataRef.current.get(p.playerID);
				if (!dataObject) continue;
				let data = dataObject;

				if (data.playableId !== p.id) {
					console.log(
						`[NicoJK][#${instanceId}] Playable switch detected for ${p.playerID}: ${data.playableId} -> ${p.id}`,
					);
					playersDataRef.current.set(p.playerID, createPlayerData(p.id));
					data =
						playersDataRef.current.get(p.playerID) || createPlayerData(p.id);
					kakologManagersRef.current.delete(p.playerID);
					if (targetPlayableRef.current?.playerID === p.playerID) {
						setComments([]);
						setJkContext(null);
						setWsStatus("disconnected");
					}
				}

				const { startAt, duration } = getBaseTiming(p);
				const status = bridge.getPlayerStatus(p.playerID);
				const service = p.service;
				if (!service?.serviceId) {
					data.primaryChannel = null;
					data.liveSources = [];
					data.replaySources = [];
					data.jkContext = null;
					syncTargetState(p.playerID);
					continue;
				}
				const channelLookupKey = `${service.serviceId}:${service.networkId || 0}`;

				if (data.channelLookupKey !== channelLookupKey) {
					data.channelLookupKey = channelLookupKey;
					data.primaryChannel = null;
					data.liveSources = [];
					data.replaySources = [];
					data.jkContext = null;
					data.sourceResolutionKey = null;
					data.isResolvingSources = false;
					data.sourceResolutionToken += 1;

					const lookupPlayableId = p.id;
					const lookupStartAt = startAt;
					const lookupDuration = duration;
					getChannelDefinition(service.serviceId, service.networkId || 0).then(
						(channel) => {
							const latest = playersDataRef.current.get(p.playerID);
							if (
								!latest ||
								latest.playableId !== lookupPlayableId ||
								latest.channelLookupKey !== channelLookupKey
							) {
								return;
							}

							latest.primaryChannel = channel;
							if (channel?.jkId) {
								const primarySource = buildPrimarySource(
									channel,
									lookupStartAt,
									lookupDuration,
								);
								if (primarySource) {
									applyPrimarySource(
										latest,
										primarySource,
										lookupStartAt,
										lookupDuration,
									);
								}
							} else {
								latest.liveSources = [];
								latest.replaySources = [];
								latest.jkContext = null;
							}
							syncTargetState(p.playerID);
						},
					);
				}

				if (data.primaryChannel?.jkId) {
					const fallbackPrimary = buildPrimarySource(
						data.primaryChannel,
						startAt,
						duration,
					);
					if (fallbackPrimary) {
						if (!p.isSeekable) {
							if (data.liveSources.length === 0) {
								data.liveSources = [fallbackPrimary];
							}
							if (data.replaySources.length === 0) {
								data.replaySources = [fallbackPrimary];
							}
							if (!data.jkContext) {
								data.jkContext = buildJkContext(
									fallbackPrimary,
									data.liveSources,
									startAt,
									duration,
								);
							}
						} else {
							if (data.liveSources.length === 0) {
								data.liveSources = [fallbackPrimary];
							}
							if (data.replaySources.length === 0) {
								data.replaySources = [fallbackPrimary];
							}
							if (!data.jkContext) {
								data.jkContext = buildJkContext(
									fallbackPrimary,
									data.replaySources,
									startAt,
									duration,
								);
							}
						}
					}
				}

				const sourceResolutionKey = data.primaryChannel?.jkId
					? `${p.id}:${p.isSeekable ? "recorded" : "live"}:${startAt}:${duration}:${data.primaryChannel.jkId}:${getProgramResolutionSignature(p)}`
					: null;
				if (
					data.primaryChannel?.jkId &&
					sourceResolutionKey &&
					data.sourceResolutionKey !== sourceResolutionKey &&
					!data.isResolvingSources
				) {
					data.isResolvingSources = true;
					const sourceResolutionToken = data.sourceResolutionToken + 1;
					data.sourceResolutionToken = sourceResolutionToken;
					const currentPlayableId = p.id;
					const queryTime = p.isSeekable
						? startAt +
							Math.min(
								Math.max(status?.time || Math.floor(duration / 2), 1),
								Math.max(duration - 1, 1),
							)
						: Math.floor(Date.now() / 1000);

					resolveCommentSources({
						primaryChannel: data.primaryChannel,
						baseStartAt: startAt,
						duration,
						isLive: !p.isSeekable,
						queryTime,
					})
						.then((resolved) => {
							const latest = playersDataRef.current.get(p.playerID);
							if (
								!latest ||
								latest.playableId !== currentPlayableId ||
								latest.sourceResolutionToken !== sourceResolutionToken
							) {
								return;
							}

							latest.isResolvingSources = false;
							latest.sourceResolutionKey = sourceResolutionKey;
							applyResolvedSources(
								latest,
								resolved,
								p.isSeekable,
								startAt,
								duration,
							);
							syncTargetState(p.playerID);
						})
						.catch((error) => {
							console.error(
								"[NicoJK] Failed to resolve comment sources",
								error,
							);
							const latest = playersDataRef.current.get(p.playerID);
							if (
								!latest ||
								latest.playableId !== currentPlayableId ||
								latest.sourceResolutionToken !== sourceResolutionToken
							) {
								return;
							}

							latest.isResolvingSources = false;
							latest.sourceResolutionKey = sourceResolutionKey;
							syncTargetState(p.playerID);
						});
				}

				if (!p.isSeekable) {
					for (const source of data.liveSources) {
						if (clientsRef.current.has(source.jkId)) {
							continue;
						}

						const jkId = source.jkId;
						const client = new CommentClient();
						client.onComment((c) => {
							for (const [pid, pData] of playersDataRef.current.entries()) {
								if (
									!pData.liveSources.some(
										(liveSource) => liveSource.jkId === jkId,
									)
								) {
									continue;
								}

								const sourceOrdinal = getSourceOrdinal(pData.liveSources, jkId);
								pData.comments = mergeComments(
									pData.comments,
									[scopeLiveComment(c, sourceOrdinal)],
									MAX_LIVE_COMMENTS,
								);
								if (targetPlayableRef.current?.playerID === pid) {
									syncTargetState(pid);
								}
							}
						});
						client.onStatusUpdate(() => {
							const currentTarget = targetPlayableRef.current;
							if (currentTarget) {
								const currentData = playersDataRef.current.get(
									currentTarget.playerID,
								);
								if (
									currentData?.liveSources.some(
										(liveSource) => liveSource.jkId === jkId,
									)
								) {
									setWsStatus(getPlayerWsStatus(currentData));
								}
							}
						});
						client.connect(jkId);
						clientsRef.current.set(jkId, client);
					}
					if (targetPlayableRef.current?.playerID === p.playerID) {
						setWsStatus(getPlayerWsStatus(data));
					}
				}

				if (p.isSeekable) {
					if (!kakologManagersRef.current.has(p.playerID)) {
						const mgr = new KakologManager();
						kakologManagersRef.current.set(p.playerID, mgr);
					}
					const mgr = kakologManagersRef.current.get(p.playerID);
					if (mgr && status && data.replaySources.length > 0) {
						mgr.setSources(startAt, data.replaySources);

						if (data.jkContext && data.replaySources[0]) {
							data.jkContext = buildJkContext(
								data.replaySources[0],
								data.replaySources,
								startAt,
								duration,
							);
						}

						mgr.fetchIfNeeded(status.time, duration).then((newOnes) => {
							if (newOnes.length > 0) {
								data.comments = mergeComments(data.comments, newOnes);
								if (targetPlayableRef.current?.playerID === p.playerID) {
									syncTargetState(p.playerID);
								}
							}
						});
					}
				}
			}

			const activeJkIds = new Set<string>();
			for (const playable of playables) {
				if (playable.isSeekable) {
					continue;
				}
				const playerData = playersDataRef.current.get(playable.playerID);
				for (const source of playerData?.liveSources || []) {
					activeJkIds.add(source.jkId);
				}
			}
			for (const [jkId, client] of clientsRef.current.entries()) {
				if (!activeJkIds.has(jkId)) {
					client.disconnect();
					clientsRef.current.delete(jkId);
				}
			}
			const activePids = new Set(
				playables
					.filter((playable) => playable.isSeekable)
					.map((p) => p.playerID),
			);
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

	const debugKiririn =
		typeof window !== "undefined"
			? (window.kiririn as DebugKiririnBridge)
			: null;

	return (
		<div
			className={`w-full h-full relative font-sans ${area.type === "playerOverlay" ? "overflow-hidden" : ""}`}
		>
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
					isLive={screenIsLive}
					playbackState={playbackState}
					wsStatus={wsStatus}
					jkContext={jkContext}
					hasActivePlayer={!!targetPlayable}
				/>
			)}

			{area.type === "pluginSettings" && <PluginSettings />}

			{debugKiririn?.toggleSeekable && (
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
							onClick={() => debugKiririn.toggleSeekable?.()}
							className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-[10px] rounded"
						>
							Toggle Seekable
						</button>
						<button
							type="button"
							onClick={() => debugKiririn.nextAreaPattern?.()}
							className="px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white text-[10px] rounded"
						>
							Next Area
						</button>
					</div>
					<div className="flex flex-col gap-1 b border-t border-gray-700 pt-1">
						<div className="text-[8px] text-gray-500">Active Players:</div>
						<div className="flex gap-1 overflow-x-auto">
							{debugKiririn.getPlayables().map((p) => (
								<div key={p.playerID} className="flex flex-col gap-1">
									<button
										type="button"
										onClick={() => debugKiririn.focusPlayable?.(p.playerID)}
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
										onClick={() => debugKiririn.closePlayer?.(p.playerID)}
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
