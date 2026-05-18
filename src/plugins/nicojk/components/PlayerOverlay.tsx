import NiconiComments, {
	type FormattedComment,
} from "@xpadev-net/niconicomments";
import { useEffect, useRef, useState } from "react";
import type { PlayerPlaybackState } from "../../../Plugin.d.ts";
import type { NiconicoComment } from "../comment-client";
import type { NicoJKContext } from "../context";
import {
	getSettings,
	type NicoJKSettings,
	SETTINGS_UPDATED_EVENT,
	STORAGE_KEY,
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

function getMaxCommentId(comments: NiconicoComment[]) {
	return comments.reduce((max, comment) => Math.max(max, comment.id), 0);
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

export default function PlayerOverlay({
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
		recordedPhase: RecordedRendererPhase;
	} | null>(null);
	const filterSignatureRef = useRef(
		getFilterSignature(getSettings(), visibleSourceKeys),
	);
	const visibleSourceKeysRef = useRef(visibleSourceKeys);
	const lastCommentIdRef = useRef<number>(0);
	const [opacity, setOpacity] = useState(getSettings().opacity);
	const [filterVersion, setFilterVersion] = useState(0);
	const [rendererInitialized, setRendererInitialized] = useState(false);

	// Settings update listener
	useEffect(() => {
		const handleUpdate = () => {
			const s = getSettings();
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
		const handleStorage = (e: StorageEvent) => {
			if (e.key === STORAGE_KEY) {
				handleUpdate();
			}
		};
		window.addEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
		window.addEventListener("storage", handleStorage);
		return () => {
			window.removeEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
			window.removeEventListener("storage", handleStorage);
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
			lastCommentIdRef.current = 0;
		};
	}, []);

	useEffect(() => {
		if (!canvasRef.current) return;

		const recordedRendererPhase: RecordedRendererPhase = !recordedCommentsReady
			? "none"
			: isLoadingRecordedComments
				? "partial"
				: "complete";
		const shouldCreateRenderer = hasDisplayCandidates;
		if (!shouldCreateRenderer) {
			if (rendererRef.current) {
				rendererRef.current.clear();
				rendererRef.current = null;
				rendererMetaRef.current = null;
				lastCommentIdRef.current = 0;
				setRendererInitialized(false);
			}
			return;
		}

		const nextMode: RendererMode = isLive ? "live" : "recorded";
		const shouldRecreate =
			!rendererRef.current ||
			rendererMetaRef.current?.mode !== nextMode ||
			rendererMetaRef.current?.playableId !== playableId ||
			rendererMetaRef.current?.filterVersion !== filterVersion ||
			(!isLive &&
				rendererMetaRef.current?.recordedPhase !== recordedRendererPhase);
		if (!shouldRecreate) {
			return;
		}

		rendererRef.current?.clear();
		const currentSettings = getSettings();
		const usesFormattedRenderer = !isLive && recordedRendererPhase !== "none";
		const initialComments = usesFormattedRenderer
			? toFormattedComments(
					comments,
					visibleSourceKeys,
					jkContext,
					currentSettings,
				)
			: [];
		const liveComments = isLive
			? toFormattedComments(
					comments,
					visibleSourceKeys,
					jkContext,
					currentSettings,
				)
			: [];
		const renderer = new NiconiComments(canvasRef.current, initialComments, {
			format: usesFormattedRenderer ? "formatted" : "empty",
		});
		if (isLive && liveComments.length > 0) {
			renderer.addComments(...liveComments);
		}
		rendererRef.current = renderer;
		rendererMetaRef.current = {
			mode: nextMode,
			playableId,
			filterVersion,
			recordedPhase: isLive ? "none" : recordedRendererPhase,
		};
		lastCommentIdRef.current = getMaxCommentId(comments);
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
		visibleSourceKeys,
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
					// vpos は絶対 unixtime × 100。nowVpos = (startAt + playerTime) * 100 で一致する。
					// startAt = initialNetworkTime（TOT/PMT 判明後に更新される）。
					nowVpos = Math.floor(
						(syncRef.current.time + elapsed + jkContextRef.current.startAt) *
							100,
					);
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
			lastCommentIdRef.current = 0;
			return;
		}

		const lastCommentId = lastCommentIdRef.current;
		const pendingComments = sortComments(comments).filter(
			(comment) => comment.id > lastCommentId,
		);
		if (pendingComments.length === 0) {
			return;
		}

		const currentSettings = getSettings();
		const parsedComments = pendingComments
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

		lastCommentIdRef.current = pendingComments.reduce(
			(max, comment) => Math.max(max, comment.id),
			lastCommentId,
		);
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
					opacity,
				}}
			/>
		</div>
	);
}
