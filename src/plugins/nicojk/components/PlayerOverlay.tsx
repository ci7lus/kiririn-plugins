import NiconiComments from "@xpadev-net/niconicomments";
import { useEffect, useRef, useState } from "react";
import type { PlayerPlaybackState } from "../../../Plugin.d.ts";
import type { NiconicoComment } from "../comment-client";
import type { NicoJKContext } from "../context";
import { getSettings, isNG } from "../ng-settings";

interface Props {
	comments: NiconicoComment[];
	width: number;
	height: number;
	isLive: boolean;
	playbackState: PlayerPlaybackState | null;
	jkContext: NicoJKContext | null;
}

export default function PlayerOverlay({
	comments,
	width,
	height,
	isLive,
	playbackState,
	jkContext,
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<NiconiComments | null>(null);
	const lastCommentIdRef = useRef<number>(0);
	const [opacity, setOpacity] = useState(getSettings().opacity);
	const [showDebugInfo, setShowDebugInfo] = useState(
		getSettings().showDebugInfo,
	);
	const [rendererInitialized, setRendererInitialized] = useState(false);

	// Settings update listener
	useEffect(() => {
		const handleUpdate = () => {
			const s = getSettings();
			setOpacity(s.opacity);
			setShowDebugInfo(s.showDebugInfo);
		};
		window.addEventListener("nicojk_settings_updated", handleUpdate);
		window.addEventListener("storage", (e) => {
			if (e.key === "nicojk_settings_v3") handleUpdate();
		});
		return () => {
			window.removeEventListener("nicojk_settings_updated", handleUpdate);
			window.removeEventListener("storage", handleUpdate);
		};
	}, []);

	const syncRef = useRef<{
		time: number;
		receivedAt: number;
		isPlaying: boolean;
	} | null>(null);

	useEffect(() => {
		if (playbackState) {
			syncRef.current = {
				isPlaying: playbackState.isPlaying,
				time: playbackState.time,
				receivedAt: performance.now(),
			};
		}
	}, [playbackState]);

	const jkContextRef = useRef(jkContext);
	useEffect(() => {
		jkContextRef.current = jkContext;
	}, [jkContext]);

	// Initial setup
	useEffect(() => {
		if (!canvasRef.current) return;

		// Create renderer
		const renderer = new NiconiComments(canvasRef.current, [], {
			format: "empty",
		});
		rendererRef.current = renderer;
		lastCommentIdRef.current = 0;
		setRendererInitialized(true);

		// Animation loop
		let animationFrameId: number;
		const animate = () => {
			if (rendererRef.current) {
				let nowVpos: number;
				if (isLive) {
					nowVpos = Math.floor(Date.now() / 10);
				} else if (syncRef.current && jkContextRef.current) {
					const elapsed = syncRef.current.isPlaying
						? (performance.now() - syncRef.current.receivedAt) / 1000
						: 0;
					nowVpos = Math.floor(
						(Math.floor(syncRef.current.time) + elapsed + jkContextRef.current.startAt) * 100,
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
			rendererRef.current?.clear();
		};
	}, [isLive]);

	// Handle new comments
	useEffect(() => {
		if (!rendererInitialized || !rendererRef.current) return;
		if (comments.length === 0) {
			lastCommentIdRef.current = 0;
			return;
		}

		const lastCommentId = lastCommentIdRef.current;
		const sorted = [...comments].sort((a, b) => a.vpos - b.vpos);
		const filtered = sorted.filter(
			(comment) =>
				comment.id > lastCommentId && !isNG(comment.content, comment.user_id),
		);

		if (filtered.length > 0) {
			const parsedComments = filtered.map((comment) => {
				return {
					id: comment.id,
					vpos: comment.vpos,
					content: comment.content,
					date: comment.date,
					date_usec: comment.date_usec,
					owner: false,
					premium: comment.premium === 1,
					mail: comment.mail,
					user_id: -1,
					layer: 0,
					is_my_post: false,
				};
			});

			rendererRef.current?.addComments(...parsedComments);
			// Update with the maximum id encountered in this batch to avoid blocking
			const maxId = parsedComments.reduce(
				(max, c) => Math.max(max, c.id),
				lastCommentId,
			);
			lastCommentIdRef.current = maxId;
		}
	}, [comments, rendererInitialized]);

	// 16:9 calculation
	let targetW = width;
	let targetH = width * (9 / 16);

	if (targetH > height) {
		targetH = height;
		targetW = height * (16 / 9);
	}

	const formatTime = (unix: number) => {
		if (!unix) return "--:--";
		return new Date(unix * 1000).toLocaleString("ja-JP", {
			hour: "2-digit",
			minute: "2-digit",
		});
	};

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
					transition: "opacity 0.2s ease-in-out",
				}}
			/>

			{showDebugInfo && jkContext && (
				<div className="absolute top-4 left-4 flex flex-col gap-1 p-2 bg-black/40 text-white rounded text-[10px] tabular-nums font-mono border border-white/20">
					<div>
						{jkContext.channelName} ({jkContext.jkId})
					</div>
					<div>
						{formatTime(jkContext.startAt)} - {formatTime(jkContext.endAt)}
					</div>
				</div>
			)}
		</div>
	);
}
