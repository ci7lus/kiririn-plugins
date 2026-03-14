import {
	Activity,
	ArrowDown,
	ArrowUp,
	Ban,
	MessageSquare,
	UserX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlayerPlaybackState } from "../../../Plugin.d.ts";
import type { NiconicoComment } from "../comment-client";
import { addNGId, isNG } from "../ng-settings";

interface Props {
	comments: NiconicoComment[];
	isLive: boolean;
	playbackState: PlayerPlaybackState | null;
	wsStatus?: string;
}

export default function PluginScreen({
	comments,
	isLive,
	playbackState,
	wsStatus,
}: Props) {
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [showScrollTop, setShowScrollTop] = useState(false);
	const [filterNG, setFilterNG] = useState(true);

	const filteredComments = filterNG
		? comments.filter((c) => !isNG(c.content, c.user_id))
		: comments;

	const displayComments = filteredComments;

	const lastScrolledTimeRef = useRef(0);

	// Scroll management
	useEffect(() => {
		if (!autoScroll || !scrollContainerRef.current) return;

		if (isLive) {
			// ライブ時は常に一番下（最新）
			// 自動追従は instant (auto) にして安定性を高める
			scrollContainerRef.current.scrollTo({
				top: scrollContainerRef.current.scrollHeight,
				behavior: "auto",
			});
		} else if (playbackState) {
			// 過去ログ時は再生時間に一番近いコメントを探す
			const targetVpos = playbackState.time * 100;

			// 0.5秒に1回程度の更新に抑える（パフォーマンスのため）
			if (Math.abs(playbackState.time - lastScrolledTimeRef.current) < 0.5)
				return;
			lastScrolledTimeRef.current = playbackState.time;

			const elements =
				scrollContainerRef.current.querySelectorAll("[data-vpos]");
			let targetElement: HTMLElement | null = null;
			for (let i = 0; i < elements.length; i++) {
				const el = elements[i] as HTMLElement;
				const vpos = parseInt(el.dataset.vpos || "0");
				if (vpos <= targetVpos) {
					targetElement = el;
				} else {
					break;
				}
			}
			if (targetElement) {
				// 追従時は instant
				targetElement.scrollIntoView({ behavior: "auto", block: "start" });
			}
		}
	}, [autoScroll, isLive, playbackState]);

	// ユーザーの意思によるスクロールを検知して自動スクロールをオフにする
	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;

		const onInteraction = () => {
			if (autoScroll) {
				// スクロール中（特に慣性スクロール中）にオフにする
				setAutoScroll(false);
			}
		};

		el.addEventListener("wheel", onInteraction, { passive: true });
		el.addEventListener("touchmove", onInteraction, { passive: true });

		return () => {
			el.removeEventListener("wheel", onInteraction);
			el.removeEventListener("touchmove", onInteraction);
		};
	}, [autoScroll]);

	const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
		const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;

		if (isLive) {
			// ライブモード時のみ、手動で一番下に戻ったら自動スクロールをオンに復帰させる
			const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
			if (isAtBottom && !autoScroll) {
				setAutoScroll(true);
			}
		}

		// 上方向に200px以上スクロールして最新（下端）が見えなくなったらボタンを表示
		setShowScrollTop(scrollHeight - scrollTop - clientHeight > 200);
	};

	const scrollToBottom = () => {
		scrollContainerRef.current?.scrollTo({
			top: scrollContainerRef.current.scrollHeight,
			behavior: "smooth",
		});
		setAutoScroll(true);
	};

	const handleNGId = (id: string) => {
		if (confirm(`ID: ${id} をNGに追加しますか？`)) {
			addNGId(id);
		}
	};

	return (
		<div className="flex flex-col h-full bg-[#1a1a1a] text-white">
			<div className="p-2 border-b border-gray-700 flex justify-between items-center bg-[#252525]">
				<div className="flex items-center gap-2">
					<MessageSquare size={16} className="text-gray-400" />
					<span className="font-bold text-sm">コメント</span>
					{isLive && (
						<div
							className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] uppercase font-bold transition-colors ${
								wsStatus === "connected"
									? "bg-green-600/20 text-green-400"
									: wsStatus === "connecting"
										? "bg-yellow-600/20 text-yellow-500 animate-pulse"
										: "bg-red-600/20 text-red-500"
							}`}
							title={`Live Connection: ${wsStatus}`}
						>
							<Activity size={10} />
							<span>{wsStatus === "connected" ? "Live" : wsStatus}</span>
						</div>
					)}
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => setAutoScroll(!autoScroll)}
						className={`p-1 rounded flex justify-center items-center gap-1 ${autoScroll ? "bg-blue-600" : "bg-gray-700"}`}
						title="自動スクロール"
					>
						<ArrowDown size={16} />{" "}
						<span className="text-sm">自動スクロール</span>
					</button>
					<button
						type="button"
						onClick={() => setFilterNG(!filterNG)}
						className={`p-1 rounded flex justify-center items-center gap-1 ${filterNG ? "bg-red-600" : "bg-gray-700"}`}
						title="NGフィルター"
					>
						<Ban size={16} /> <span className="text-sm">NGフィルター</span>
					</button>
				</div>
			</div>

			<div
				ref={scrollContainerRef}
				className="flex-1 overflow-y-auto p-2 space-y-1 relative"
				onScroll={handleScroll}
			>
				{displayComments.map((c) => (
					<div
						key={`${c.no}-${c.id}`}
						data-vpos={c.vpos}
						className="group flex items-center gap-2 p-2 hover:bg-[#333] rounded text-sm transition-colors leading-relaxed"
					>
						<div className="flex-shrink-0 w-8 text-right text-gray-500 text-[10px] tabular-nums">
							{c.no}
						</div>
						<div className="flex-1 min-w-0 break-words line-height-1.5 self-center">
							{c.content}
						</div>
						<div className="flex-shrink-0">
							<button
								type="button"
								onClick={() => handleNGId(c.user_id)}
								className="text-gray-400 hover:text-red-400 p-1"
								title={`ID: ${c.user_id} をNGに追加`}
							>
								<UserX size={14} />
							</button>
						</div>
					</div>
				))}
			</div>

			{/* Floating Scroll to Bottom Button */}
			{showScrollTop && (
				<button
					type="button"
					onClick={scrollToBottom}
					className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-500 text-white p-3 rounded-full shadow-2xl transition-all hover:scale-110 active:scale-95 animate-in fade-in zoom-in duration-200 z-10"
					title="最新へ戻る"
				>
					<ArrowUp size={20} className="rotate-180" />
				</button>
			)}
		</div>
	);
}
