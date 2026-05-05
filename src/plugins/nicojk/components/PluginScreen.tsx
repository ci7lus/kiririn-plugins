import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	ArrowUp,
	Ban,
	Bookmark,
	Check,
	Info,
	MessageSquare,
	MoreVertical,
	UserX,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayerPlaybackState } from "../../../Plugin.d.ts";
import type { ConnectionStatus, NiconicoComment } from "../comment-client";
import type { NicoJKContext } from "../context";
import {
	addNGCommand,
	addNGId,
	getSettings,
	isNG,
	SETTINGS_UPDATED_EVENT,
	saveSettings,
} from "../ng-settings";

const CHAPTER_WINDOW_SECONDS = 10;
const CHAPTER_COOLDOWN_SECONDS = 60;
const CHAPTER_MINIMUM_COUNT = 3;
const CHAPTER_SEEK_LEAD_SECONDS = 5;
const CHAPTER_LABELS = ["A", "B", "C", "D", "OP", "ED"] as const;

type ChapterLabel = (typeof CHAPTER_LABELS)[number];

type ChapterPoint = {
	key: string;
	label: ChapterLabel;
	relativeSec: number;
	position: number;
};

interface Props {
	comments: NiconicoComment[];
	isLive: boolean;
	duration: number;
	playbackState: PlayerPlaybackState | null;
	wsStatus?: ConnectionStatus;
	jkContext: NicoJKContext | null;
	channelDisplayState: {
		message: string | null;
		detail: string | null;
		isLoading: boolean;
		fetchedCommentCount: number;
	};
	hasActivePlayer: boolean;
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
	connected: "接続済",
	connecting: "接続中",
	disconnected: "切断",
	error: "エラー",
};

const SOURCE_KIND_LABELS: Record<
	NicoJKContext["sources"][number]["kind"],
	string
> = {
	primary: "主",
	simulcast: "サイマル",
	replay: "別",
};

export default function PluginScreen({
	comments,
	isLive,
	duration,
	playbackState,
	wsStatus,
	jkContext,
	channelDisplayState,
	hasActivePlayer,
}: Props) {
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const activeTooltipRootRef = useRef<HTMLDivElement | null>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [showScrollTop, setShowScrollTop] = useState(false);
	const [filterNG, setFilterNG] = useState(true);
	const [showChapters, setShowChapters] = useState(false);
	const [showInfo, setShowInfo] = useState(false);
	const [showMenu, setShowMenu] = useState(false);
	const [settings, setSettings] = useState(getSettings());
	const [hoveredCommentId, setHoveredCommentId] = useState<number | null>(null);
	const [pinnedCommentId, setPinnedCommentId] = useState<number | null>(null);

	useEffect(() => {
		const handleUpdate = () => setSettings(getSettings());
		window.addEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
		return () =>
			window.removeEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
	}, []);

	const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = parseFloat(e.target.value);
		const newSettings = { ...settings, opacity: val };
		setSettings(newSettings);
		saveSettings(newSettings);
	};

	const filteredComments = useMemo(() => {
		const ngFiltered = filterNG
			? comments.filter((comment) => !isNG(comment.content, comment.user_id))
			: comments;
		if (!settings.hideSecondarySourceComments) {
			return ngFiltered;
		}
		return ngFiltered.filter(
			(comment) => Math.max(comment.sourceOrdinal || 0, 0) === 0,
		);
	}, [comments, filterNG, settings.hideSecondarySourceComments]);

	const displayComments = filteredComments;
	const statusText = channelDisplayState.detail || channelDisplayState.message;
	const fetchedCommentCount = Math.max(
		comments.length,
		channelDisplayState.fetchedCommentCount,
	);
	const sourceCommentCounts = useMemo(() => {
		const counts = new Map<number, number>();
		for (const comment of comments) {
			const sourceOrdinal = Math.max(comment.sourceOrdinal || 0, 0);
			counts.set(sourceOrdinal, (counts.get(sourceOrdinal) || 0) + 1);
		}
		return counts;
	}, [comments]);
	const chapterComments = useMemo(() => {
		if (!settings.hideSecondarySourceComments) {
			return comments;
		}
		return comments.filter(
			(comment) => Math.max(comment.sourceOrdinal || 0, 0) === 0,
		);
	}, [comments, settings.hideSecondarySourceComments]);
	const chapters = useMemo<ChapterPoint[]>(() => {
		if (isLive || !jkContext || duration <= 0) {
			return [];
		}

		type ChapterMatch = {
			label: ChapterLabel;
			relativeSec: number;
			commentId: number;
		};

		type ChapterBucket = {
			matches: ChapterMatch[];
			counts: Map<ChapterLabel, number>;
		};

		const buckets = new Map<number, ChapterBucket>();

		for (const comment of chapterComments) {
			const label = normalizeChapterLabel(comment.content);
			if (!label) {
				continue;
			}

			const relativeSec = comment.vpos / 100 - jkContext.startAt;
			if (
				!Number.isFinite(relativeSec) ||
				relativeSec < 0 ||
				relativeSec > duration
			) {
				continue;
			}

			const bucketIndex = Math.floor(relativeSec / CHAPTER_WINDOW_SECONDS);
			let bucket = buckets.get(bucketIndex);
			if (!bucket) {
				bucket = {
					matches: [],
					counts: new Map<ChapterLabel, number>(),
				};
				buckets.set(bucketIndex, bucket);
			}

			bucket.matches.push({
				label,
				relativeSec,
				commentId: comment.id,
			});
			bucket.counts.set(label, (bucket.counts.get(label) || 0) + 1);
		}

		const candidates = [...buckets.entries()]
			.sort(([left], [right]) => left - right)
			.flatMap(([bucketIndex, bucket]) => {
				if (bucket.matches.length < CHAPTER_MINIMUM_COUNT) {
					return [];
				}

				const sortedMatches = [...bucket.matches].sort((left, right) => {
					if (left.relativeSec !== right.relativeSec) {
						return left.relativeSec - right.relativeSec;
					}
					return left.commentId - right.commentId;
				});
				const anchor = sortedMatches[0];
				const highestCount = Math.max(...bucket.counts.values());
				const dominantLabels = CHAPTER_LABELS.filter(
					(label) => (bucket.counts.get(label) || 0) === highestCount,
				);
				const dominantLabel =
					sortedMatches.find((match) => dominantLabels.includes(match.label))
						?.label || anchor.label;

				return [
					{
						key: `${bucketIndex}:${anchor.commentId}`,
						label: dominantLabel,
						relativeSec: anchor.relativeSec,
						position: clamp(anchor.relativeSec / duration, 0, 1),
					},
				];
			});

		const filtered: ChapterPoint[] = [];
		let nextAvailableSec = -Infinity;

		for (const candidate of candidates) {
			if (candidate.relativeSec < nextAvailableSec) {
				continue;
			}

			filtered.push(candidate);
			nextAvailableSec = candidate.relativeSec + CHAPTER_COOLDOWN_SECONDS;
		}

		return filtered;
	}, [chapterComments, duration, isLive, jkContext]);
	const canSeekToChapters = !isLive && duration > 0;
	const playbackProgress = clamp(playbackState?.position ?? 0, 0, 1);

	const rowVirtualizer = useVirtualizer({
		count: hasActivePlayer ? displayComments.length : 0,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => 56,
		overscan: 10,
		getItemKey: (index) => {
			const item = displayComments[index];
			return item ? `${item.no}-${item.id}` : index;
		},
	});

	const findCommentIndexByVpos = useCallback(
		(targetVpos: number) => {
			let low = 0;
			let high = displayComments.length - 1;
			let result = -1;

			while (low <= high) {
				const mid = Math.floor((low + high) / 2);
				const value = displayComments[mid]?.vpos ?? 0;
				if (value <= targetVpos) {
					result = mid;
					low = mid + 1;
				} else {
					high = mid - 1;
				}
			}

			return result;
		},
		[displayComments],
	);

	const lastScrolledTimeRef = useRef(0);

	// Scroll management
	useEffect(() => {
		if (!hasActivePlayer || !autoScroll) return;

		if (isLive) {
			if (displayComments.length > 0) {
				rowVirtualizer.scrollToIndex(displayComments.length - 1, {
					align: "end",
					behavior: "auto",
				});
			}
			return;
		}

		if (!playbackState) return;

		// vpos は絶対時間(Unix秒) × 100 となっているので、ターゲットも絶対時間に合わせる
		const absoluteTime = (jkContext?.startAt ?? 0) + playbackState.time;
		const targetVpos = absoluteTime * 100;

		// 録画追従は軽量寄りに間引いて負荷を抑える
		if (Math.abs(playbackState.time - lastScrolledTimeRef.current) < 0.9) {
			return;
		}
		lastScrolledTimeRef.current = playbackState.time;

		const targetIndex = findCommentIndexByVpos(targetVpos);
		if (targetIndex >= 0) {
			rowVirtualizer.scrollToIndex(targetIndex, {
				align: "end",
				behavior: "auto",
			});
		}
	}, [
		autoScroll,
		displayComments,
		findCommentIndexByVpos,
		hasActivePlayer,
		isLive,
		jkContext?.startAt,
		playbackState,
		rowVirtualizer,
	]);

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

	const scrollToBottom = useCallback(() => {
		if (displayComments.length > 0) {
			rowVirtualizer.scrollToIndex(displayComments.length - 1, {
				align: "end",
				behavior: "auto",
			});
		}
		setAutoScroll(true);
	}, [displayComments.length, rowVirtualizer]);

	const handleNGId = useCallback((id: string) => {
		if (confirm(`ID: ${id} をNGに追加しますか？`)) {
			addNGId(id);
		}
	}, []);

	const handleNGCommand = useCallback(
		(command: string) => {
			if (!command || settings.ngCommands.includes(command)) {
				return;
			}
			if (confirm(`mail: ${command} をNGコマンドに追加しますか？`)) {
				addNGCommand(command);
			}
		},
		[settings.ngCommands],
	);

	const handleTooltipMouseLeave = useCallback((commentId: number) => {
		setHoveredCommentId((current) => (current === commentId ? null : current));
	}, []);

	const handleHideSecondarySourceCommentsChange = useCallback(() => {
		const newSettings = {
			...settings,
			hideSecondarySourceComments: !settings.hideSecondarySourceComments,
		};
		setSettings(newSettings);
		saveSettings(newSettings);
	}, [settings]);

	useEffect(() => {
		setHoveredCommentId(null);
		setPinnedCommentId((current) => {
			if (current == null) {
				return null;
			}
			return displayComments.some((comment) => comment.id === current)
				? current
				: null;
		});
	}, [displayComments]);

	useEffect(() => {
		if (isLive || !hasActivePlayer) {
			setShowChapters(false);
		}
	}, [hasActivePlayer, isLive]);

	useEffect(() => {
		if (pinnedCommentId == null) {
			activeTooltipRootRef.current = null;
			return;
		}

		const handlePointerDownOutside = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}
			if (activeTooltipRootRef.current?.contains(target)) {
				return;
			}
			setPinnedCommentId(null);
			setHoveredCommentId(null);
		};

		document.addEventListener("pointerdown", handlePointerDownOutside);
		return () =>
			document.removeEventListener("pointerdown", handlePointerDownOutside);
	}, [pinnedCommentId]);

	const formatTime = (unix: number) => {
		if (!unix) return "--:--";
		return new Date(unix * 1000).toLocaleString("ja-JP", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	const formatTimeRange = (startUnix: number, endUnix: number) => {
		return `${formatTime(startUnix)} 〜 ${formatTime(endUnix)}`;
	};

	const formatSourceLabel = (source: NicoJKContext["sources"][number]) => {
		return `${source.channelName} (${source.jkId}) ${formatTime(source.startAt)}-`;
	};

	const formatPlaybackTime = (vpos: number) => {
		// vpos は絶対時間(Unix秒) × 100。プレイヤー表示時間 = vpos/100 - startAt。
		const relativeSec = vpos / 100 - (jkContext?.startAt ?? 0);
		if (relativeSec < 0) return "--:--";
		return formatRelativeSeconds(relativeSec);
	};

	const formatCommentTimestamp = (comment: NiconicoComment) => {
		const unix = comment.date + comment.date_usec / 1_000_000;
		return new Date(unix * 1000).toLocaleString("ja-JP", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	const handleChapterSeek = useCallback(
		(chapter: ChapterPoint) => {
			if (!canSeekToChapters) {
				return;
			}
			const seekPosition = clamp(
				Math.max(0, chapter.relativeSec - CHAPTER_SEEK_LEAD_SECONDS) / duration,
				0,
				1,
			);
			window.kiririn.seek(seekPosition, playbackState?.playerID);
		},
		[canSeekToChapters, duration, playbackState?.playerID],
	);

	return (
		<div className="flex flex-col h-full bg-[#1a1a1a] text-white overflow-hidden relative">
			{/* Persistent Header */}
			<div className="p-2 border-b border-gray-700 flex justify-between items-center gap-2 bg-[#252525] shrink-0">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					<button
						type="button"
						onClick={() => {
							setShowInfo(!showInfo);
							setShowChapters(false);
							setShowMenu(false);
						}}
						className="p-1 hover:bg-gray-700 rounded transition-colors text-blue-400"
						title="情報"
						disabled={!hasActivePlayer}
					>
						<Info size={18} />
					</button>
					<div className="flex items-center gap-1 min-w-0 flex-1">
						{hasActivePlayer && isLive && (
							<div
								className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-bold transition-colors ${
									wsStatus === "connected"
										? "bg-green-600/20 text-green-400"
										: wsStatus === "connecting"
											? "bg-yellow-600/20 text-yellow-500 animate-pulse"
											: "bg-red-600/20 text-red-500"
								}`}
								title={`Live Connection: ${wsStatus}`}
							>
								<span>{wsStatus ? STATUS_LABELS[wsStatus] : ""}</span>
							</div>
						)}
						{jkContext && (
							<div className="flex items-center gap-2 min-w-0 flex-1">
								<div
									className="text-sm text-gray-200 shrink-0"
									title={`${jkContext.channelName} (${jkContext.jkId})`}
								>
									{jkContext.channelName} ({jkContext.jkId})
									{jkContext.sources.length > 1
										? ` +${jkContext.sources.length - 1}`
										: ""}
								</div>
								{statusText && (
									<div
										className="min-w-0 flex-1 truncate text-xs text-gray-400"
										title={statusText}
									>
										{statusText}
									</div>
								)}
								{channelDisplayState.isLoading && (
									<div
										className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-gray-500 border-t-transparent animate-spin"
										title={
											statusText || channelDisplayState.message || "読み込み中"
										}
									/>
								)}
							</div>
						)}
						{!jkContext && channelDisplayState.message && (
							<div
								className="flex items-center gap-2 min-w-0 flex-1"
								title={channelDisplayState.message}
							>
								<div className="text-sm text-gray-400 min-w-0 flex-1 truncate">
									{channelDisplayState.message}
								</div>
								{channelDisplayState.isLoading && (
									<div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-gray-500 border-t-transparent animate-spin" />
								)}
							</div>
						)}
					</div>
				</div>
				<div className="flex gap-2 shrink-0">
					{hasActivePlayer && !isLive && (
						<button
							type="button"
							onClick={() => {
								setShowChapters(!showChapters);
								setShowMenu(false);
								setShowInfo(false);
							}}
							className={`p-1 hover:bg-gray-700 rounded transition-colors ${showChapters ? "text-blue-400 bg-gray-700" : "text-gray-400"}`}
							title="コメントチャプター"
						>
							<Bookmark size={20} />
						</button>
					)}
					<button
						type="button"
						onClick={() => {
							setShowMenu(!showMenu);
							setShowChapters(false);
							setShowInfo(false);
						}}
						disabled={!hasActivePlayer}
						className={`p-1 hover:bg-gray-700 rounded transition-colors ${showMenu ? "text-blue-400 bg-gray-700" : "text-gray-400"}`}
						title="メニュー"
					>
						<MoreVertical size={20} />
					</button>
				</div>
			</div>

			<div
				ref={scrollContainerRef}
				className="flex-1 overflow-y-auto p-2 relative"
				onScroll={handleScroll}
			>
				{!hasActivePlayer ? (
					<div className="flex flex-col h-full items-center justify-center p-4">
						<MessageSquare size={48} className="text-gray-600 mb-4" />
						<p className="text-gray-400 text-sm">プレイヤーを待機中…</p>
						<p className="text-gray-600 text-[10px] mt-2 text-center">
							プレイヤーを操作するとコメントが表示されます
						</p>
					</div>
				) : displayComments.length === 0 ? (
					<div className="flex flex-col h-full items-center justify-center p-4">
						<MessageSquare size={42} className="text-gray-700 mb-3" />
						<p className="text-gray-500 text-sm">
							表示できるコメントがありません
						</p>
					</div>
				) : (
					<div
						className="relative w-full"
						style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
					>
						{rowVirtualizer.getVirtualItems().map((virtualRow) => {
							const c = displayComments[virtualRow.index];
							if (!c) {
								return null;
							}
							const sourceOrdinal = Math.max(c.sourceOrdinal || 0, 0);
							const commentSource = jkContext?.sources[sourceOrdinal] || null;
							const isSecondarySource = sourceOrdinal > 0;
							const isHoveredTooltip = hoveredCommentId === c.id;
							const isPinnedTooltip = pinnedCommentId === c.id;
							const isTooltipVisible = isHoveredTooltip || isPinnedTooltip;
							const mailCommands = [...new Set(c.mail.filter(Boolean))].filter(
								(n) => n !== "184" && !n.startsWith("nico:"),
							);
							return (
								<div
									key={virtualRow.key}
									ref={rowVirtualizer.measureElement}
									data-index={virtualRow.index}
									data-vpos={c.vpos}
									style={{
										position: "absolute",
										top: virtualRow.start,
										left: 0,
										width: "100%",
										zIndex: isHoveredTooltip ? 40 : isPinnedTooltip ? 30 : 0,
									}}
								>
									<div className="group relative mb-1 flex items-center gap-2 rounded p-2 text-sm leading-relaxed transition-colors hover:bg-[#333]">
										<div
											ref={(node) => {
												if (pinnedCommentId === c.id) {
													activeTooltipRootRef.current = node;
												} else if (activeTooltipRootRef.current === node) {
													activeTooltipRootRef.current = null;
												}
											}}
											className="relative min-w-0 flex-1"
										>
											<button
												type="button"
												onMouseEnter={() => setHoveredCommentId(c.id)}
												onMouseLeave={() => handleTooltipMouseLeave(c.id)}
												onClick={() => {
													if (pinnedCommentId === c.id) {
														setPinnedCommentId(null);
														setHoveredCommentId(null);
														return;
													}
													setPinnedCommentId(c.id);
												}}
												className="flex w-full min-w-0 items-center gap-2 text-left focus:outline-none"
											>
												<div className="flex-shrink-0 w-8 text-right text-gray-500 text-[10px] tabular-nums flex flex-col items-end leading-none">
													<span>{c.no}</span>
													{!isLive && (
														<span className="text-[8px] text-gray-600 mt-0.5">
															{formatPlaybackTime(c.vpos)}
														</span>
													)}
												</div>
												<div
													className={`flex min-w-0 flex-1 items-center gap-2 self-center ${isSecondarySource ? "opacity-70" : ""}`}
												>
													<div className="min-w-0 flex-1 break-words line-height-1.5">
														{c.content}
													</div>
													{isSecondarySource && (
														<span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] text-blue-200">
															{commentSource
																? SOURCE_KIND_LABELS[commentSource.kind]
																: `src${sourceOrdinal + 1}`}
														</span>
													)}
												</div>
											</button>
											{isTooltipVisible && (
												<div className="absolute inset-x-10 top-full z-10 mt-1 rounded-md border border-gray-600 bg-[#101010] p-2 text-[10px] text-gray-200 shadow-2xl">
													<div className="flex items-center justify-between gap-2 text-gray-300">
														<span>No.{c.no}</span>
														<span>{formatCommentTimestamp(c)}</span>
													</div>
													<div className="mt-1 text-white break-words">
														{c.content}
													</div>
													<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-400">
														<span>ID: {c.user_id || "-"}</span>
														{!isLive && (
															<span>
																再生位置: {formatPlaybackTime(c.vpos)}
															</span>
														)}
														<span>
															ソース:{" "}
															{commentSource
																? formatSourceLabel(commentSource)
																: `src${sourceOrdinal + 1}`}
														</span>
														{commentSource && (
															<span>
																種別: {SOURCE_KIND_LABELS[commentSource.kind]}
															</span>
														)}
														<span>premium: {c.premium}</span>
													</div>
													<div className="mt-2 border-t border-gray-800 pt-2">
														<div className="mb-1 text-gray-400">コマンド</div>
														{mailCommands.length > 0 ? (
															<div className="flex flex-wrap gap-1.5">
																{mailCommands.map((command) => {
																	const isNGCommand =
																		settings.ngCommands.includes(command);
																	return (
																		<button
																			key={command}
																			type="button"
																			onClick={(event) => {
																				event.stopPropagation();
																				handleNGCommand(command);
																			}}
																			disabled={isNGCommand}
																			className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors ${
																				isNGCommand
																					? "cursor-default border-gray-700 bg-gray-800 text-gray-500"
																					: "border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20"
																			}`}
																			title={
																				isNGCommand
																					? "既にNGコマンドに登録済み"
																					: `${command} をNGコマンドに追加`
																			}
																		>
																			{command}
																		</button>
																	);
																})}
															</div>
														) : (
															<div className="text-gray-500">-</div>
														)}
													</div>
												</div>
											)}
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
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Floating Scroll to Bottom Button */}
			{hasActivePlayer && showScrollTop && (
				<button
					type="button"
					onClick={scrollToBottom}
					className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-500 text-white p-3 rounded-full shadow-2xl transition-all hover:scale-110 active:scale-95 animate-in fade-in zoom-in duration-200 z-10"
					title="最新へ戻る"
				>
					<ArrowUp size={20} className="rotate-180" />
				</button>
			)}

			{/* Chapter Popover */}
			{hasActivePlayer && !isLive && showChapters && (
				<div className="absolute inset-x-2 top-12 z-50 rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
					<div className="mb-3 flex items-start justify-between gap-3">
						<h4 className="font-bold text-gray-100">コメントチャプター</h4>
						<button
							type="button"
							onClick={() => setShowChapters(false)}
							className="text-gray-400 hover:text-white"
						>
							<X size={16} />
						</button>
					</div>

					{canSeekToChapters && chapters.length > 0 ? (
						<div className="space-y-3">
							<div className="rounded-md border border-gray-700 bg-[#1f1f1f] px-3 py-4">
								<div className="relative h-16">
									<div className="absolute inset-x-0 top-9 h-1 rounded-full bg-gray-700" />
									<div
										className="absolute left-0 top-9 h-1 rounded-full bg-blue-500"
										style={{ width: `${playbackProgress * 100}%` }}
									/>
									{chapters.map((chapter) => (
										<button
											key={chapter.key}
											type="button"
											onClick={() => handleChapterSeek(chapter)}
											className="group absolute top-1 -translate-x-1/2 text-left"
											style={{ left: `${chapter.position * 100}%` }}
											title={`${chapter.label} ${formatRelativeSeconds(chapter.relativeSec)}`}
										>
											<div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-gray-600 bg-[#101010] px-2 py-1 text-[10px] text-gray-100 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
												{formatRelativeSeconds(chapter.relativeSec)}
											</div>
											<div className="flex h-7 w-7 items-center justify-center rounded border border-blue-400 bg-blue-500 text-[10px] font-bold text-blue-200 shadow-md transition-colors group-hover:bg-blue-500/25">
												{chapter.label}
											</div>
										</button>
									))}
								</div>
								<div className="mt-2 flex justify-between text-[10px] text-gray-500">
									<span>0:00</span>
									<span>{formatRelativeSeconds(duration)}</span>
								</div>
							</div>
						</div>
					) : canSeekToChapters ? (
						<div className="rounded-md border border-dashed border-gray-700 bg-[#1f1f1f] px-3 py-6 text-center text-sm text-gray-400">
							コメントチャプターはありません
						</div>
					) : (
						<div className="rounded-md border border-dashed border-gray-700 bg-[#1f1f1f] px-3 py-6 text-center text-sm text-gray-400">
							シークに必要な再生時間が取得できません
						</div>
					)}
				</div>
			)}

			{/* Settings Menu Popover */}
			{hasActivePlayer && showMenu && (
				<div className="absolute inset-x-2 top-12 z-50 bg-[#333] border border-gray-600 rounded-lg shadow-2xl p-4 animate-in fade-in slide-in-from-top-2 duration-200">
					<div className="flex justify-between items-start mb-4">
						<h4 className="font-bold text-gray-200 flex items-center gap-1">
							表示設定
						</h4>
						<button
							type="button"
							onClick={() => setShowMenu(false)}
							className="text-gray-400 hover:text-white"
						>
							<X size={16} />
						</button>
					</div>
					<div className="space-y-2">
						<button
							type="button"
							onClick={() => setAutoScroll(!autoScroll)}
							className="w-full flex items-center justify-between p-2 hover:bg-gray-700 rounded transition-colors text-sm"
						>
							<div className="flex items-center gap-2">
								<ArrowDown size={16} />
								<span>自動スクロール</span>
							</div>
							{autoScroll && <Check size={16} className="text-blue-400" />}
						</button>
						<button
							type="button"
							onClick={() => setFilterNG(!filterNG)}
							className="w-full flex items-center justify-between p-2 hover:bg-gray-700 rounded transition-colors text-sm"
						>
							<div className="flex items-center gap-2">
								<Ban size={16} />
								<span>NGフィルター</span>
							</div>
							{filterNG && <Check size={16} className="text-red-400" />}
						</button>
						<button
							type="button"
							onClick={handleHideSecondarySourceCommentsChange}
							className="w-full flex items-center justify-between p-2 hover:bg-gray-700 rounded transition-colors text-sm"
						>
							<div className="flex items-center gap-2">
								<MessageSquare size={16} />
								<span>主ch以外を表示しない</span>
							</div>
							{settings.hideSecondarySourceComments && (
								<Check size={16} className="text-blue-400" />
							)}
						</button>

						<div className="pt-3 mt-1 border-t border-gray-700 mx-1">
							<div className="flex justify-between text-xs mb-2">
								<span className="text-gray-400 font-medium">
									コメントの濃度
								</span>
								<span className="text-blue-400 font-mono">
									{Math.round(settings.opacity * 100)}%
								</span>
							</div>
							<input
								type="range"
								min="0.0"
								max="1.0"
								step="0.05"
								value={settings.opacity}
								onChange={handleOpacityChange}
								className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 mb-1"
							/>
						</div>
					</div>
				</div>
			)}

			{/* Info Popover */}
			{hasActivePlayer && showInfo && (
				<div className="absolute inset-x-2 top-12 z-50 bg-[#333] border border-gray-600 rounded-lg shadow-2xl p-4 animate-in fade-in slide-in-from-top-2 duration-200">
					<div className="flex justify-between items-start mb-2">
						<h4 className="font-bold text-blue-400 flex items-center gap-1">
							<Info size={14} /> チャンネル情報
						</h4>
						<button
							type="button"
							onClick={() => setShowInfo(false)}
							className="text-gray-400 hover:text-white"
						>
							<X size={16} />
						</button>
					</div>
					{jkContext ? (
						<div className="space-y-2 text-sm">
							<div className="border-b border-gray-700 pb-1">
								<div className="text-gray-400 mb-1">チャンネル</div>
								<div className="space-y-1 text-xs">
									{jkContext.sources.map((source, index) => {
										const sourceCount = sourceCommentCounts.get(index) || 0;
										return (
											<div
												key={source.key}
												className="flex justify-between items-start gap-3"
											>
												<div className="min-w-0">
													<div className="text-gray-300 truncate">
														{source.channelName} ({source.jkId})
														{!isLive && ` ${sourceCount}件`}
													</div>
													{!isLive && (
														<div className="text-gray-500">
															{formatTimeRange(source.startAt, source.endAt)}
														</div>
													)}
												</div>
												<span className="text-gray-500 shrink-0">
													{SOURCE_KIND_LABELS[source.kind]}
												</span>
											</div>
										);
									})}
								</div>
							</div>
							{!isLive && (
								<div className="flex justify-between">
									<span className="text-gray-400">取得コメント数</span>
									<span className="text-blue-300 tabular-nums">
										{fetchedCommentCount}件
									</span>
								</div>
							)}
						</div>
					) : (
						<p className="text-sm text-gray-500 italic">
							情報が取得できませんでした
						</p>
					)}
				</div>
			)}
		</div>
	);
}

function normalizeChapterLabel(content: string): ChapterLabel | null {
	const normalized = content
		.trim()
		.replace(/[Ａ-Ｚａ-ｚ]/g, (char) =>
			String.fromCharCode(char.charCodeAt(0) - 0xfee0),
		)
		.toUpperCase();

	return CHAPTER_LABELS.find((label) => label === normalized) || null;
}

function formatRelativeSeconds(value: number): string {
	if (!Number.isFinite(value) || value < 0) {
		return "--:--";
	}

	const totalSeconds = Math.floor(value);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
			.toString()
			.padStart(2, "0")}`;
	}

	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
