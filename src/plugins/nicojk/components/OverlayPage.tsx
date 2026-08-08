import NiconiComments, {
	type FormattedComment,
} from "@xpadev-net/niconicomments";
import { useEffect, useRef, useState } from "react";
import type { PlayerPlaybackState } from "../../../vendor/Plugin";
import type { NiconicoComment } from "../comment-client";
import type { NicoJKContext } from "../context";
import {
	getSettings,
	type NicoJKSettings,
	SETTINGS_UPDATED_EVENT,
} from "../ng-settings";

interface Props {
	comments: NiconicoComment[];
	visibleSourceKeys: string[] | null;
	width: number;
	height: number;
	playableId: string | null;
	isLive: boolean;
	hasDisplayCandidates: boolean;
	recordedCommentsReady: boolean;
	isLoadingRecordedComments: boolean;
	playbackState: PlayerPlaybackState | null;
	jkContext: NicoJKContext | null;
}

type RendererMode = "live" | "recorded";
type RecordedRendererPhase = "none" | "partial" | "complete";

// niconicomments へ渡すコメントを1時間（3600秒）単位で区切る
const RENDER_SEGMENT_SIZE = 3600;
// 次の枠に切り替わる際、前の枠の最後1分間（60秒）を交差させる
const RENDER_SEGMENT_OVERLAP = 60;
// App側のライブコメント上限に余裕を加えた件数でrendererを再構築し、内部保持量を固定する
const MAX_LIVE_RENDERER_COMMENTS = 1200;

function getSegmentComments(
	comments: NiconicoComment[],
	segment: number,
	startAt: number,
): NiconicoComment[] {
	if (segment <= 0) {
		const segmentEndVpos = (startAt + RENDER_SEGMENT_SIZE) * 100;
		return comments.filter((c) => c.vpos < segmentEndVpos);
	}

	const overlapStartVpos =
		(startAt + segment * RENDER_SEGMENT_SIZE - RENDER_SEGMENT_OVERLAP) * 100;
	const segmentEndVpos = (startAt + (segment + 1) * RENDER_SEGMENT_SIZE) * 100;
	return comments.filter(
		(c) => c.vpos >= overlapStartVpos && c.vpos < segmentEndVpos,
	);
}

function getCommentSourceKey(
	comment: NiconicoComment,
	jkContext: NicoJKContext | null,
) {
	const sourceOrdinal = Math.max(comment.sourceOrdinal || 0, 0);
	return jkContext?.sources[sourceOrdinal]?.key || null;
}

function isCommentVisibleForSource(
	comment: NiconicoComment,
	jkContext: NicoJKContext | null,
	visibleSourceKeys: string[] | null,
) {
	if (visibleSourceKeys == null) {
		return true;
	}

	const sourceKey = getCommentSourceKey(comment, jkContext);
	return sourceKey != null && visibleSourceKeys.includes(sourceKey);
}

function getFilterSignature(
	settings: NicoJKSettings,
	visibleSourceKeys: string[] | null,
) {
	return JSON.stringify({
		ngWords: settings.ngWords,
		ngIds: settings.ngIds,
		ngCommands: settings.ngCommands,
		secondarySourceOpacity: settings.secondarySourceOpacity,
		visibleSourceKeys,
	});
}

function getCommentTimingSignature(jkContext: NicoJKContext | null) {
	return JSON.stringify(
		jkContext?.sources.map((source) => [
			source.key,
			source.chapterCorrection?.offsetSeconds ?? null,
			source.chapterCorrection?.enabled ?? null,
		]) || [],
	);
}

function isCommentNGBySettings(
	comment: string | undefined,
	userId: string | undefined,
	settings: NicoJKSettings,
) {
	if (userId && settings.ngIds.includes(userId)) {
		return true;
	}
	if (comment && settings.ngWords.some((word) => comment.includes(word))) {
		return true;
	}
	return false;
}

function filterMailBySettings(
	mail: string[] | undefined,
	settings: NicoJKSettings,
) {
	if (!mail) {
		return [];
	}
	if (settings.ngCommands.length === 0) {
		return [...mail];
	}
	return mail.filter((command) => {
		return command != null && !settings.ngCommands.includes(command);
	});
}

function formatOpacityMailValue(value: number) {
	return value.toFixed(2).replace(/\.?0+$/, "");
}

function sortComments(comments: NiconicoComment[]) {
	return [...comments].sort(
		(a, b) =>
			a.vpos - b.vpos ||
			a.date - b.date ||
			a.date_usec - b.date_usec ||
			a.id - b.id,
	);
}

function toFormattedComment(
	comment: NiconicoComment,
	visibleSourceKeys: string[] | null,
	jkContext: NicoJKContext | null,
	settings: NicoJKSettings,
): FormattedComment | null {
	if (
		comment.content == null ||
		isCommentNGBySettings(comment.content, comment.user_id, settings)
	) {
		return null;
	}

	if (!isCommentVisibleForSource(comment, jkContext, visibleSourceKeys)) {
		return null;
	}

	const sourceOrdinal = Math.max(comment.sourceOrdinal || 0, 0);
	const mail = filterMailBySettings(comment.mail, settings);
	if (sourceOrdinal > 0) {
		mail.push(
			`nico:opacity:${formatOpacityMailValue(settings.secondarySourceOpacity)}`,
		);
	}

	return {
		id: comment.id,
		vpos: comment.vpos,
		content: comment.content,
		date: comment.date,
		date_usec: comment.date_usec,
		owner: false,
		premium: comment.premium === 1,
		mail,
		user_id: -1,
		layer: 0,
		is_my_post: false,
	};
}

function toFormattedComments(
	comments: NiconicoComment[],
	visibleSourceKeys: string[] | null,
	jkContext: NicoJKContext | null,
	settings: NicoJKSettings,
) {
	return sortComments(comments)
		.map((comment) =>
			toFormattedComment(comment, visibleSourceKeys, jkContext, settings),
		)
		.filter((comment): comment is FormattedComment => comment != null);
}

export default function OverlayPage({
	comments,
	visibleSourceKeys,
	width,
	height,
	playableId,
	isLive,
	hasDisplayCandidates,
	recordedCommentsReady,
	isLoadingRecordedComments,
	playbackState,
	jkContext,
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<NiconiComments | null>(null);
	const rendererMetaRef = useRef<{
		mode: RendererMode;
		playableId: string | null;
		filterVersion: number;
		commentTimingSignature: string;
		recordedPhase: RecordedRendererPhase;
		segment: number;
		liveRevision: number;
	} | null>(null);
	const filterSignatureRef = useRef(
		getFilterSignature(getSettings(), visibleSourceKeys),
	);
	const visibleSourceKeysRef = useRef(visibleSourceKeys);
	const renderedLiveCommentIdsRef = useRef<Set<number>>(new Set());
	const liveRendererCommentCountRef = useRef(0);
	const [showComments, setShowComments] = useState(getSettings().showComments);
	const [opacity, setOpacity] = useState(getSettings().opacity);
	const [filterVersion, setFilterVersion] = useState(0);
	const [rendererInitialized, setRendererInitialized] = useState(false);
	const [liveRendererRevision, setLiveRendererRevision] = useState(0);
	const [currentSegment, setCurrentSegment] = useState(0);
	const currentSegmentRef = useRef(0);

	// Settings update listener
	useEffect(() => {
		const handleUpdate = () => {
			const s = getSettings();
			setShowComments(s.showComments);
			setOpacity(s.opacity);
			const nextFilterSignature = getFilterSignature(
				s,
				visibleSourceKeysRef.current,
			);
			if (nextFilterSignature !== filterSignatureRef.current) {
				filterSignatureRef.current = nextFilterSignature;
				setFilterVersion((version) => version + 1);
			}
		};
		window.addEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
		return () => {
			window.removeEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
		};
	}, []);

	useEffect(() => {
		visibleSourceKeysRef.current = visibleSourceKeys;
		const nextFilterSignature = getFilterSignature(
			getSettings(),
			visibleSourceKeys,
		);
		if (nextFilterSignature !== filterSignatureRef.current) {
			filterSignatureRef.current = nextFilterSignature;
			setFilterVersion((version) => version + 1);
		}
	}, [visibleSourceKeys]);

	const syncRef = useRef<{
		time: number;
		receivedAt: number;
		isPlaying: boolean;
		playableID: string;
		rate: number;
	} | null>(null);

	useEffect(() => {
		if (playbackState) {
			if (
				syncRef.current &&
				syncRef.current.playableID === playbackState.playableID &&
				syncRef.current.time === playbackState.time &&
				syncRef.current.isPlaying === playbackState.isPlaying &&
				syncRef.current.rate === playbackState.rate
			) {
				return;
			}
			syncRef.current = {
				isPlaying: playbackState.isPlaying,
				time: playbackState.time,
				playableID: playbackState.playableID,
				rate: playbackState.rate,
				receivedAt: performance.now(),
			};
		} else {
			syncRef.current = null;
		}
	}, [playbackState]);

	const jkContextRef = useRef(jkContext);
	useEffect(() => {
		jkContextRef.current = jkContext;
	}, [jkContext]);

	useEffect(() => {
		return () => {
			rendererRef.current?.clear();
			rendererRef.current = null;
			rendererMetaRef.current = null;
			renderedLiveCommentIdsRef.current.clear();
			liveRendererCommentCountRef.current = 0;
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: playableId 変更時にセグメントをリセットする必要がある
	useEffect(() => {
		currentSegmentRef.current = 0;
		setCurrentSegment(0);
	}, [playableId]);

	useEffect(() => {
		if (!canvasRef.current) return;

		const recordedRendererPhase: RecordedRendererPhase = !recordedCommentsReady
			? "none"
			: isLoadingRecordedComments
				? "partial"
				: "complete";
		const shouldCreateRenderer = hasDisplayCandidates && showComments;
		if (!shouldCreateRenderer) {
			if (rendererRef.current) {
				rendererRef.current.clear();
				rendererRef.current = null;
				rendererMetaRef.current = null;
				renderedLiveCommentIdsRef.current.clear();
				liveRendererCommentCountRef.current = 0;
				setRendererInitialized(false);
			}
			return;
		}

		const nextMode: RendererMode = isLive ? "live" : "recorded";
		const commentTimingSignature = getCommentTimingSignature(jkContext);
		const shouldRecreate =
			!rendererRef.current ||
			rendererMetaRef.current?.mode !== nextMode ||
			rendererMetaRef.current?.playableId !== playableId ||
			rendererMetaRef.current?.filterVersion !== filterVersion ||
			rendererMetaRef.current?.commentTimingSignature !==
				commentTimingSignature ||
			(!isLive &&
				rendererMetaRef.current?.recordedPhase !== recordedRendererPhase) ||
			(!isLive && rendererMetaRef.current?.segment !== currentSegment) ||
			(isLive &&
				rendererMetaRef.current?.liveRevision !== liveRendererRevision);
		if (!shouldRecreate) {
			return;
		}

		rendererRef.current?.clear();
		const currentSettings = getSettings();
		const usesFormattedRenderer = !isLive && recordedRendererPhase !== "none";
		const segmentComments =
			!isLive && usesFormattedRenderer
				? getSegmentComments(comments, currentSegment, jkContext?.startAt || 0)
				: comments;
		const initialComments = usesFormattedRenderer
			? toFormattedComments(
					segmentComments,
					visibleSourceKeys,
					jkContext,
					currentSettings,
				)
			: [];
		const liveComments = isLive
			? toFormattedComments(
					segmentComments,
					visibleSourceKeys,
					jkContext,
					currentSettings,
				)
			: [];
		const renderer = new NiconiComments(canvasRef.current, initialComments, {
			format: usesFormattedRenderer ? "formatted" : "empty",
			lazy: true,
		});
		if (isLive && liveComments.length > 0) {
			renderer.addComments(...liveComments);
		}
		rendererRef.current = renderer;
		rendererMetaRef.current = {
			mode: nextMode,
			playableId,
			filterVersion,
			commentTimingSignature,
			recordedPhase: isLive ? "none" : recordedRendererPhase,
			segment: currentSegment,
			liveRevision: liveRendererRevision,
		};
		if (isLive) {
			renderedLiveCommentIdsRef.current = new Set(
				segmentComments.map((comment) => comment.id),
			);
			liveRendererCommentCountRef.current = liveComments.length;
		} else {
			renderedLiveCommentIdsRef.current.clear();
			liveRendererCommentCountRef.current = 0;
		}
		setRendererInitialized(true);
	}, [
		comments,
		filterVersion,
		hasDisplayCandidates,
		isLoadingRecordedComments,
		isLive,
		jkContext,
		playableId,
		recordedCommentsReady,
		showComments,
		visibleSourceKeys,
		currentSegment,
		liveRendererRevision,
	]);

	useEffect(() => {
		let animationFrameId: number;
		const animate = () => {
			if (rendererRef.current) {
				let nowVpos: number;
				if (isLive) {
					nowVpos = Math.floor(Date.now() / 10);
				} else if (syncRef.current && jkContextRef.current) {
					const elapsed = syncRef.current.isPlaying
						? ((performance.now() - syncRef.current.receivedAt) / 1000) *
							syncRef.current.rate
						: 0;
					const playerTime = syncRef.current.time + elapsed;
					// vpos は絶対 unixtime × 100。nowVpos = (startAt + playerTime) * 100 で一致する。
					// startAt = initialNetworkTime（TOT/PMT 判明後に更新される）。
					nowVpos = Math.floor(
						(playerTime + jkContextRef.current.startAt) * 100,
					);

					const segment = Math.floor(playerTime / RENDER_SEGMENT_SIZE);
					if (segment !== currentSegmentRef.current) {
						currentSegmentRef.current = segment;
						setCurrentSegment(segment);
					}
				} else {
					nowVpos = 0;
				}
				rendererRef.current.drawCanvas(nowVpos);
			}
			animationFrameId = requestAnimationFrame(animate);
		};
		animate();

		return () => {
			cancelAnimationFrame(animationFrameId);
		};
	}, [isLive]);

	useEffect(() => {
		if (!isLive || !rendererInitialized || !rendererRef.current) return;
		if (rendererMetaRef.current?.mode !== "live") return;
		if (comments.length === 0) {
			renderedLiveCommentIdsRef.current.clear();
			if (liveRendererCommentCountRef.current > 0) {
				liveRendererCommentCountRef.current = 0;
				setLiveRendererRevision((revision) => revision + 1);
			}
			return;
		}

		const pendingComments = comments.filter(
			(comment) => !renderedLiveCommentIdsRef.current.has(comment.id),
		);
		if (pendingComments.length === 0) {
			return;
		}

		if (
			liveRendererCommentCountRef.current + pendingComments.length >
			MAX_LIVE_RENDERER_COMMENTS
		) {
			setLiveRendererRevision((revision) => revision + 1);
			return;
		}

		const currentSettings = getSettings();
		const parsedComments = sortComments(pendingComments)
			.map((comment) =>
				toFormattedComment(
					comment,
					visibleSourceKeys,
					jkContext,
					currentSettings,
				),
			)
			.filter((comment): comment is FormattedComment => comment != null);
		if (parsedComments.length > 0) {
			rendererRef.current?.addComments(...parsedComments);
		}
		for (const comment of pendingComments) {
			renderedLiveCommentIdsRef.current.add(comment.id);
		}
		liveRendererCommentCountRef.current += parsedComments.length;
	}, [comments, isLive, jkContext, rendererInitialized, visibleSourceKeys]);

	// 16:9 calculation
	let targetW = width;
	let targetH = width * (9 / 16);

	if (targetH > height) {
		targetH = height;
		targetW = height * (16 / 9);
	}

	return (
		<div className="w-full h-full min-h-full flex flex-col items-center justify-center pointer-events-none bg-transparent overflow-hidden">
			<canvas
				ref={canvasRef}
				width={1920}
				height={1080}
				style={{
					width: targetW,
					height: targetH,
					opacity: showComments ? opacity : 0,
				}}
			/>
		</div>
	);
}
