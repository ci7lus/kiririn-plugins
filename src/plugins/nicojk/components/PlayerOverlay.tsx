import NiconiComments from "@xpadev-net/niconicomments";
import { useEffect, useRef, useState } from "react";
import type { PlayerPlaybackState } from "../../../Plugin.d.ts";
import type { NiconicoComment } from "../comment-client";
import { getSettings, isNG } from "../ng-settings";

interface Props {
	comments: NiconicoComment[];
	width: number;
	height: number;
	isLive: boolean;
	playbackState: PlayerPlaybackState | null;
}

export default function PlayerOverlay({
	comments,
	width,
	height,
	isLive,
	playbackState,
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<NiconiComments | null>(null);
	const lastCommentIdRef = useRef<number>(0);
	const [opacity, setOpacity] = useState(getSettings().opacity);

	// Settings update listener
	useEffect(() => {
		const handleUpdate = () => {
			setOpacity(getSettings().opacity);
		};
		window.addEventListener("nicojk_settings_updated", handleUpdate);
		return () =>
			window.removeEventListener("nicojk_settings_updated", handleUpdate);
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

	// Initial setup
	useEffect(() => {
		if (!canvasRef.current) return;

		// Create renderer
		const renderer = new NiconiComments(canvasRef.current, [], {
			format: "empty",
		});
		rendererRef.current = renderer;

		// Animation loop
		let animationFrameId: number;
		const animate = () => {
			if (rendererRef.current) {
				let nowVpos: number;
				if (isLive) {
					nowVpos = Math.floor(Date.now() / 10);
				} else if (syncRef.current) {
					// 補間（再生時間から何ミリ秒経過したかを秒に直して加算）
					// 一時停止中 (isPlaying: false) は加算しない
					const elapsed = syncRef.current.isPlaying
						? (performance.now() - syncRef.current.receivedAt) / 1000
						: 0;
					// 1/100s 単位に変換
					nowVpos = Math.floor((syncRef.current.time + elapsed) * 100);
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
		if (!rendererRef.current) return;

		if (comments.length === 0) {
			lastCommentIdRef.current = 0;
			return;
		}

		const lastCommentId = lastCommentIdRef.current;
		const parsedComments = comments
			.filter(
				(comment) =>
					comment.id > lastCommentId && !isNG(comment.content, comment.user_id),
			)
			.map((comment) => {
				return {
					id: comment.id,
					vpos: comment.vpos,
					content: comment.content,
					date: comment.date,
					date_usec: comment.date_usec,
					owner: false,
					premium: comment.premium === 1,
					mail: [comment.mail],
					user_id: -1,
					layer: 0,
					is_my_post: false,
				};
			});
		rendererRef.current.addComments(...parsedComments);
		const lastComment = parsedComments[parsedComments.length - 1];
		if (lastComment) {
			lastCommentIdRef.current = lastComment.id;
		}
	}, [comments]);

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
					transition: "opacity 0.2s ease-in-out",
				}}
			/>
		</div>
	);
}
