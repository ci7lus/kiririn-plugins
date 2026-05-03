import { useCallback, useEffect, useRef, useState } from "react";
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
import { type KakologFetchProgress, KakologManager } from "./kakolog-manager";
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
	areSourcesResolved: boolean;
	isLookingUpChannel: boolean;
	channelLookupKey: string | null;
	sourceResolutionKey: string | null;
	isResolvingSources: boolean;
	sourceResolutionToken: number;
	recordedCommentsReady: boolean;
	isLoadingRecordedComments: boolean;
	recordedCommentsLoadToken: number;
	recordedFetchProgress: KakologFetchProgress | null;
};

function createPlayerData(playableId: string | null): PlayerData {
	return {
		playableId,
		comments: [],
		primaryChannel: null,
		liveSources: [],
		replaySources: [],
		jkContext: null,
		areSourcesResolved: false,
		isLookingUpChannel: false,
		channelLookupKey: null,
		sourceResolutionKey: null,
		isResolvingSources: false,
		sourceResolutionToken: 0,
		recordedCommentsReady: false,
		isLoadingRecordedComments: false,
		recordedCommentsLoadToken: 0,
		recordedFetchProgress: null,
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

function resetRecordedCommentsState(data: PlayerData) {
	data.comments = [];
	data.recordedCommentsReady = false;
	data.isLoadingRecordedComments = false;
	data.recordedCommentsLoadToken += 1;
	data.recordedFetchProgress = null;
}

function getHasDisplayCandidates(
	data: PlayerData | undefined,
	isLive: boolean,
) {
	if (!data || !data.areSourcesResolved) {
		return false;
	}

	return isLive ? data.liveSources.length > 0 : data.replaySources.length > 0;
}

interface ChannelDisplayState {
	message: string | null;
	detail: string | null;
	isLoading: boolean;
	fetchedCommentCount: number;
}

function createChannelDisplayState(
	overrides: Partial<ChannelDisplayState> = {},
): ChannelDisplayState {
	return {
		message: null,
		detail: null,
		isLoading: false,
		fetchedCommentCount: 0,
		...overrides,
	};
}

const EMPTY_CHANNEL_DISPLAY_STATE = createChannelDisplayState();

function getFetchedCommentCount(data?: PlayerData) {
	return Math.max(
		data?.comments.length || 0,
		data?.recordedFetchProgress?.fetchedComments || 0,
	);
}

function formatRecordedFetchProgress(progress: KakologFetchProgress | null) {
	if (!progress) {
		return null;
	}

	const sourceLabel = progress.currentSourceJkId || "次のリクエスト待ち";
	return `${sourceLabel} ${progress.currentRequest}/${progress.totalRequests} リクエスト 残り${progress.remainingRequests}件 取得済${progress.fetchedComments}件`;
}

function getRelayPendingChannelDisplayState(): ChannelDisplayState {
	return createChannelDisplayState({
		message: "実況情報を同期中",
	});
}

function getChannelDisplayState(
	playable: Playable | null,
	data?: PlayerData,
): ChannelDisplayState {
	if (!playable) {
		return EMPTY_CHANNEL_DISPLAY_STATE;
	}

	const fetchedCommentCount = getFetchedCommentCount(data);

	if (!playable.service?.serviceId) {
		return createChannelDisplayState({
			message: "チャンネル情報を待機中",
			fetchedCommentCount,
		});
	}

	if (!data) {
		return getRelayPendingChannelDisplayState();
	}

	if (data.channelLookupKey == null) {
		return createChannelDisplayState({
			message: "チャンネル情報を取得待ち",
			fetchedCommentCount,
		});
	}

	if (data.isLookingUpChannel || data.channelLookupKey == null) {
		return createChannelDisplayState({
			message: "チャンネル情報を取得中",
			isLoading: true,
			fetchedCommentCount,
		});
	}

	if (!data.primaryChannel) {
		return createChannelDisplayState({
			message: "対応するチャンネル情報が見つかりません",
			isLoading: false,
			fetchedCommentCount,
		});
	}

	if (!data.primaryChannel.jkId) {
		return createChannelDisplayState({
			message: "このチャンネルに紐づく実況IDがありません",
			isLoading: false,
			fetchedCommentCount,
		});
	}

	if (data.isResolvingSources) {
		return createChannelDisplayState({
			message: data.primaryChannel.syobocalId
				? "しょぼかるから実況ソースを取得中"
				: "実況ソースを取得中",
			isLoading: Boolean(data.primaryChannel.syobocalId),
			fetchedCommentCount,
		});
	}

	if (!data.areSourcesResolved) {
		return createChannelDisplayState({
			message: data.primaryChannel.syobocalId
				? "しょぼかる取得開始待ち"
				: "実況ソース取得待ち",
			fetchedCommentCount,
		});
	}

	if (
		!data.jkContext &&
		data.areSourcesResolved &&
		!getHasDisplayCandidates(data, !playable.isSeekable)
	) {
		return createChannelDisplayState({
			message: "利用できる実況ソースがありません",
			isLoading: false,
			fetchedCommentCount,
		});
	}

	if (!data.jkContext) {
		return createChannelDisplayState({
			message: "実況情報を準備中",
			fetchedCommentCount,
		});
	}

	if (
		playable.isSeekable &&
		getHasDisplayCandidates(data, false) &&
		!data.recordedCommentsReady &&
		!data.isLoadingRecordedComments
	) {
		return createChannelDisplayState({
			message: "コメントデータ取得待ち",
			fetchedCommentCount,
		});
	}

	if (data.isLoadingRecordedComments) {
		return createChannelDisplayState({
			message: "コメントデータを取得中",
			detail: formatRecordedFetchProgress(data.recordedFetchProgress),
			isLoading: true,
			fetchedCommentCount,
		});
	}

	return createChannelDisplayState({
		fetchedCommentCount,
	});
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
		sourceOrdinal,
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
	channelDisplayState: ChannelDisplayState;
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
	const [hasDisplayCandidates, setHasDisplayCandidates] = useState(false);
	const [recordedCommentsReady, setRecordedCommentsReady] = useState(false);
	const [isLoadingRecordedComments, setIsLoadingRecordedComments] =
		useState(false);
	const [channelDisplayState, setChannelDisplayState] =
		useState<ChannelDisplayState>(EMPTY_CHANNEL_DISPLAY_STATE);

	const areaRef = useRef<DisplayArea | null>(null);
	const targetPlayableRef = useRef<Playable | null>(null);
	const relayChannelRef = useRef<BroadcastChannel | null>(null);
	const screenRelayChannelRef = useRef<BroadcastChannel | null>(null);
	const screenRelayPlayerIdRef = useRef<string | null>(null);
	const screenSnapshotsRef = useRef<Map<string, PlayerOverlaySnapshot>>(
		new Map(),
	);
	const screenSnapshotMetaRef = useRef<{
		playerID: string | null;
		playableId: string | null;
	}>({
		playerID: null,
		playableId: null,
	});
	const commentsRef = useRef<NiconicoComment[]>([]);
	const jkContextRef = useRef<NicoJKContext | null>(null);
	const channelDisplayStateRef = useRef<ChannelDisplayState>(
		EMPTY_CHANNEL_DISPLAY_STATE,
	);
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
		channelDisplayStateRef.current = channelDisplayState;
	}, [channelDisplayState]);

	useEffect(() => {
		wsStatusRef.current = wsStatus;
	}, [wsStatus]);

	useEffect(() => {
		overlayIsLiveRef.current = !targetPlayable?.isSeekable;
	}, [targetPlayable?.isSeekable]);

	const applyPluginScreenSnapshot = useCallback(
		(snapshot: PlayerOverlaySnapshot) => {
			screenSnapshotsRef.current.set(snapshot.playerID, snapshot);
			screenSnapshotMetaRef.current = {
				playerID: snapshot.playerID,
				playableId: snapshot.playableId,
			};
			setComments(snapshot.comments);
			setJkContext(snapshot.jkContext);
			setChannelDisplayState(snapshot.channelDisplayState);
			setWsStatus(snapshot.wsStatus);
			setScreenIsLive(snapshot.isLive);
		},
		[],
	);

	const clearPluginScreenState = useCallback(
		(displayState: ChannelDisplayState, isLive = false) => {
			screenSnapshotMetaRef.current = {
				playerID: null,
				playableId: null,
			};
			setComments([]);
			setJkContext(null);
			setChannelDisplayState(displayState);
			setWsStatus("disconnected");
			setScreenIsLive(isLive);
		},
		[],
	);

	const getCachedPluginScreenSnapshot = useCallback(
		(playerID: string, playableId: string | null) => {
			const snapshot = screenSnapshotsRef.current.get(playerID);
			if (!snapshot) {
				return null;
			}
			if (
				playableId &&
				snapshot.playableId &&
				snapshot.playableId !== playableId
			) {
				return null;
			}
			return snapshot;
		},
		[],
	);

	const hasCurrentPluginScreenSnapshot = useCallback(
		(playerID: string, playableId: string | null) => {
			return (
				screenSnapshotMetaRef.current.playerID === playerID &&
				screenSnapshotMetaRef.current.playableId === playableId
			);
		},
		[],
	);

	const requestPluginScreenSnapshot = useCallback((playerID: string) => {
		if (screenRelayPlayerIdRef.current !== playerID) {
			return;
		}
		screenRelayChannelRef.current?.postMessage({
			type: "requestSnapshot",
		} satisfies PlayerOverlayRelayMessage);
	}, []);

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
					channelDisplayState: channelDisplayStateRef.current,
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
				channelDisplayState,
				wsStatus,
				isLive: !targetPlayable?.isSeekable,
			},
		} satisfies PlayerOverlayRelayMessage);
	}, [
		area?.type,
		area?.playerID,
		comments,
		jkContext,
		channelDisplayState,
		wsStatus,
		targetPlayable?.id,
		targetPlayable?.isSeekable,
	]);

	useEffect(() => {
		if (area?.type !== "pluginScreen") return;

		const playerID = targetPlayable?.playerID;
		const expectedPlayableId = targetPlayable?.id || null;

		if (!playerID) {
			clearPluginScreenState(EMPTY_CHANNEL_DISPLAY_STATE);
			return;
		}

		const channel = createPlayerOverlayRelayChannel(playerID);
		screenRelayChannelRef.current = channel;
		screenRelayPlayerIdRef.current = playerID;
		channel.onmessage = (event: MessageEvent<PlayerOverlayRelayMessage>) => {
			if (event.data.type !== "snapshot") return;
			if (
				expectedPlayableId &&
				event.data.payload.playableId &&
				event.data.payload.playableId !== expectedPlayableId
			) {
				return;
			}

			applyPluginScreenSnapshot(event.data.payload);
		};

		const cachedSnapshot = getCachedPluginScreenSnapshot(
			playerID,
			expectedPlayableId,
		);
		if (cachedSnapshot) {
			applyPluginScreenSnapshot(cachedSnapshot);
		} else if (!hasCurrentPluginScreenSnapshot(playerID, expectedPlayableId)) {
			clearPluginScreenState(
				getRelayPendingChannelDisplayState(),
				!targetPlayable?.isSeekable,
			);
		}

		requestPluginScreenSnapshot(playerID);
		const retryTimer = window.setTimeout(() => {
			if (!hasCurrentPluginScreenSnapshot(playerID, expectedPlayableId)) {
				requestPluginScreenSnapshot(playerID);
			}
		}, 500);

		return () => {
			window.clearTimeout(retryTimer);
			channel.onmessage = null;
			channel.close();
			if (screenRelayChannelRef.current === channel) {
				screenRelayChannelRef.current = null;
				screenRelayPlayerIdRef.current = null;
			}
		};
	}, [
		area?.type,
		applyPluginScreenSnapshot,
		clearPluginScreenState,
		getCachedPluginScreenSnapshot,
		hasCurrentPluginScreenSnapshot,
		requestPluginScreenSnapshot,
		targetPlayable?.id,
		targetPlayable?.isSeekable,
		targetPlayable?.playerID,
	]);

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
			const currentPlayable = targetPlayableRef.current;
			const isLive = !currentPlayable?.isSeekable;
			setComments(data?.comments || []);
			setJkContext(data?.jkContext || null);
			setChannelDisplayState(getChannelDisplayState(currentPlayable, data));
			setWsStatus(getPlayerWsStatus(data));
			setHasDisplayCandidates(getHasDisplayCandidates(data, isLive));
			setRecordedCommentsReady(Boolean(data?.recordedCommentsReady));
			setIsLoadingRecordedComments(Boolean(data?.isLoadingRecordedComments));
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
				clearPluginScreenState(EMPTY_CHANNEL_DISPLAY_STATE);
				setHasDisplayCandidates(false);
				setRecordedCommentsReady(false);
				setIsLoadingRecordedComments(false);
				return;
			}

			setTargetPlayable(targetP);
			targetPlayableRef.current = targetP;
			setPlaybackState(targetS);

			if (currentArea.type === "playerOverlay" && targetP) {
				const data = playersDataRef.current.get(targetP.playerID);
				setComments(data?.comments || []);
				setJkContext(data?.jkContext || null);
				setChannelDisplayState(getChannelDisplayState(targetP, data));
				setWsStatus(getPlayerWsStatus(data));
				setHasDisplayCandidates(
					getHasDisplayCandidates(data, !targetP.isSeekable),
				);
				setRecordedCommentsReady(Boolean(data?.recordedCommentsReady));
				setIsLoadingRecordedComments(Boolean(data?.isLoadingRecordedComments));
			} else if (targetP) {
				const cachedSnapshot = getCachedPluginScreenSnapshot(
					targetP.playerID,
					targetP.id,
				);
				if (cachedSnapshot) {
					applyPluginScreenSnapshot(cachedSnapshot);
				} else if (
					!hasCurrentPluginScreenSnapshot(targetP.playerID, targetP.id)
				) {
					clearPluginScreenState(
						getRelayPendingChannelDisplayState(),
						!targetP.isSeekable,
					);
				} else {
					setScreenIsLive(!targetP.isSeekable);
				}
				requestPluginScreenSnapshot(targetP.playerID);
				setHasDisplayCandidates(false);
				setRecordedCommentsReady(false);
				setIsLoadingRecordedComments(false);
			} else {
				clearPluginScreenState(EMPTY_CHANNEL_DISPLAY_STATE);
				setHasDisplayCandidates(false);
				setRecordedCommentsReady(false);
				setIsLoadingRecordedComments(false);
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
			screenSnapshotsRef.current.delete(pid);
			if (screenSnapshotMetaRef.current.playerID === pid) {
				screenSnapshotMetaRef.current = {
					playerID: null,
					playableId: null,
				};
			}
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
						setChannelDisplayState(getChannelDisplayState(p, data));
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
					data.areSourcesResolved = true;
					data.isLookingUpChannel = false;
					if (p.isSeekable) {
						resetRecordedCommentsState(data);
					} else {
						data.comments = [];
						data.recordedFetchProgress = null;
					}
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
					data.areSourcesResolved = false;
					data.isLookingUpChannel = true;
					data.comments = [];
					data.recordedCommentsReady = false;
					data.isLoadingRecordedComments = false;
					data.recordedCommentsLoadToken += 1;
					data.recordedFetchProgress = null;
					data.sourceResolutionKey = null;
					data.isResolvingSources = false;
					data.sourceResolutionToken += 1;

					const lookupPlayableId = p.id;
					const lookupStartAt = startAt;
					const lookupDuration = duration;
					const lookupIsSeekable = p.isSeekable;
					syncTargetState(p.playerID);
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
							latest.isLookingUpChannel = false;
							if (channel?.jkId) {
								latest.areSourcesResolved = false;
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
								latest.areSourcesResolved = true;
								if (lookupIsSeekable) {
									resetRecordedCommentsState(latest);
								} else {
									latest.comments = [];
									latest.recordedFetchProgress = null;
								}
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
					data.areSourcesResolved = false;
					if (p.isSeekable) {
						resetRecordedCommentsState(data);
					}
					data.isResolvingSources = true;
					const sourceResolutionToken = data.sourceResolutionToken + 1;
					data.sourceResolutionToken = sourceResolutionToken;
					const currentPlayableId = p.id;
					const isSeekable = p.isSeekable;
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
							latest.areSourcesResolved = true;
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
							latest.areSourcesResolved = true;
							if (isSeekable) {
								latest.recordedCommentsReady = false;
							}
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
					if (mgr && data.replaySources.length > 0) {
						mgr.setSources(startAt, data.replaySources);

						if (data.jkContext && data.replaySources[0]) {
							data.jkContext = buildJkContext(
								data.replaySources[0],
								data.replaySources,
								startAt,
								duration,
							);
						}

						if (
							data.areSourcesResolved &&
							!data.recordedCommentsReady &&
							!data.isLoadingRecordedComments
						) {
							data.isLoadingRecordedComments = true;
							if (targetPlayableRef.current?.playerID === p.playerID) {
								syncTargetState(p.playerID);
							}
							const loadToken = data.recordedCommentsLoadToken + 1;
							data.recordedCommentsLoadToken = loadToken;
							const currentPlayableId = p.id;
							const initialPlayerTime = status?.time || 0;
							mgr.setProgressListener((progress) => {
								const latest = playersDataRef.current.get(p.playerID);
								if (
									!latest ||
									latest.playableId !== currentPlayableId ||
									latest.recordedCommentsLoadToken !== loadToken
								) {
									return;
								}

								latest.recordedFetchProgress = progress;
								if (targetPlayableRef.current?.playerID === p.playerID) {
									syncTargetState(p.playerID);
								}
							});

							mgr
								.fetchAll(duration, {
									priorityTime: initialPlayerTime,
									onPriorityChunkFetched: (initialComments) => {
										const latest = playersDataRef.current.get(p.playerID);
										if (
											!latest ||
											latest.playableId !== currentPlayableId ||
											latest.recordedCommentsLoadToken !== loadToken
										) {
											return;
										}

										latest.comments = initialComments;
										latest.recordedCommentsReady = true;
										if (targetPlayableRef.current?.playerID === p.playerID) {
											syncTargetState(p.playerID);
										}
									},
								})
								.then((allComments) => {
									const latest = playersDataRef.current.get(p.playerID);
									if (
										!latest ||
										latest.playableId !== currentPlayableId ||
										latest.recordedCommentsLoadToken !== loadToken
									) {
										return;
									}

									latest.comments = allComments;
									latest.recordedFetchProgress = null;
									latest.isLoadingRecordedComments = false;
									latest.recordedCommentsReady = true;
									mgr.setProgressListener(null);
									if (targetPlayableRef.current?.playerID === p.playerID) {
										syncTargetState(p.playerID);
									}
								})
								.catch((error) => {
									console.error(
										"[NicoJK] Failed to fetch recorded comments",
										error,
									);
									const latest = playersDataRef.current.get(p.playerID);
									if (
										!latest ||
										latest.playableId !== currentPlayableId ||
										latest.recordedCommentsLoadToken !== loadToken
									) {
										return;
									}

									latest.recordedFetchProgress = null;
									latest.isLoadingRecordedComments = false;
									mgr.setProgressListener(null);
									if (targetPlayableRef.current?.playerID === p.playerID) {
										syncTargetState(p.playerID);
									}
								});
						}
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
	}, [
		applyPluginScreenSnapshot,
		clearPluginScreenState,
		getCachedPluginScreenSnapshot,
		hasCurrentPluginScreenSnapshot,
		instanceId,
		requestPluginScreenSnapshot,
	]);

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
					playableId={targetPlayable?.id || null}
					isLive={!targetPlayable?.isSeekable}
					hasDisplayCandidates={hasDisplayCandidates}
					recordedCommentsReady={recordedCommentsReady}
					isLoadingRecordedComments={isLoadingRecordedComments}
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
					channelDisplayState={channelDisplayState}
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
