import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	ArrowUp,
	Ban,
	Bookmark,
	Check,
	CircleMinus,
	CirclePlus,
	Filter,
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

const CHAPTER_LABELS = ["A", "B", "C", "D", "OP", "ED"] as const;
const IGNORE_COMMANDS = ["184", "medium", "naka", "white"];
const TOOLTIP_MIN_HEIGHT = 160;
const TOOLTIP_SAFE_MARGIN = 8;

type ChapterLabel = (typeof CHAPTER_LABELS)[number];

type ChapterPoint = {
	key: string;
	label: ChapterLabel;
	relativeSec: number;
	position: number;
};

interface Props {
	comments: NiconicoComment[];
	visibleSourceKeys: string[] | null;
	onVisibleSourceKeysChange: (sourceKeys: string[] | null) => void;
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

const SOURCE_KIND_BADGE_CLASSES: Record<
	NicoJKContext["sources"][number]["kind"],
	string
> = {
	primary: "border-sky-500/40 bg-sky-500/15 text-sky-200",
	simulcast: "border-amber-500/40 bg-amber-500/15 text-amber-200",
	replay: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
};

export default function PluginScreen({
	comments,
	visibleSourceKeys,
	onVisibleSourceKeysChange,
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
	const chapterWindowSeconds = settings.chapterWindowSeconds;
	const chapterCooldownSeconds = settings.chapterCooldownSeconds;
	const chapterMinimumCount = settings.chapterMinimumCount;
	const chapterSeekLeadSeconds = settings.chapterSeekLeadSeconds;

	useEffect(() => {
		const handleUpdate = () => setSettings(getSettings());
		window.addEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
		return () =>
			window.removeEventListener(SETTINGS_UPDATED_EVENT, handleUpdate);
	}, []);

	const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = parseFloat(e.target.value);
		setSettings(
			saveSettings({
				...settings,
				opacity: val,
			}),
		);
	};

	const filteredComments = useMemo(() => {
		const ngFiltered = filterNG
			? comments.filter((comment) => !isNG(comment.content, comment.user_id))
			: comments;
		return ngFiltered.filter((comment) =>
			isCommentVisibleForSource(comment, jkContext, visibleSourceKeys),
		);
	}, [comments, filterNG, jkContext, visibleSourceKeys]);

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
		return comments.filter((comment) =>
			isCommentVisibleForSource(comment, jkContext, visibleSourceKeys),
		);
	}, [comments, jkContext, visibleSourceKeys]);
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

			const bucketIndex = Math.floor(relativeSec / chapterWindowSeconds);
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
				if (bucket.matches.length < chapterMinimumCount) {
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
			nextAvailableSec = candidate.relativeSec + chapterCooldownSeconds;
		}

		return filtered;
	}, [
		chapterComments,
		chapterCooldownSeconds,
		chapterMinimumCount,
		chapterWindowSeconds,
		duration,
		isLive,
		jkContext,
	]);
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

		const absoluteTime = (jkContext?.startAt ?? 0) + playbackState.time;
		const targetVpos = absoluteTime * 100;

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

	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;

		const onInteraction = () => {
			if (autoScroll) {
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
			const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
			if (isAtBottom && !autoScroll) {
				setAutoScroll(true);
			}
		}

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

	const canShowOnlySource = (jkContext?.sources.length || 0) > 1;
	const allSourcesVisible = areAllSourcesVisible(visibleSourceKeys, jkContext);

	const handleShowAllSources = useCallback(() => {
		onVisibleSourceKeysChange(null);
	}, [onVisibleSourceKeysChange]);

	const handleToggleSourceVisibility = useCallback(
		(sourceKey: string) => {
			if (!jkContext) {
				return;
			}

			onVisibleSourceKeysChange(
				toggleSourceVisibility(visibleSourceKeys, sourceKey, jkContext),
			);
		},
		[jkContext, onVisibleSourceKeysChange, visibleSourceKeys],
	);

	const handleShowOnlySource = useCallback(
		(sourceKey: string) => {
			onVisibleSourceKeysChange([sourceKey]);
		},
		[onVisibleSourceKeysChange],
	);

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
		return `${source.channelName} (${source.jkId}) ${formatTimeRange(source.startAt, source.endAt)}`;
	};

	const formatPlaybackTime = (vpos: number) => {
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
				Math.max(0, chapter.relativeSec - chapterSeekLeadSeconds) / duration,
				0,
				1,
			);
			window.kiririn.seek(seekPosition, playbackState?.playerID);
		},
		[
			canSeekToChapters,
			chapterSeekLeadSeconds,
			duration,
			playbackState?.playerID,
		],
	);

	return (
		<div className="relative flex h-full flex-col overflow-hidden bg-[#1a1a1a] text-white">
			<div className="shrink-0 border-b border-gray-700 bg-[#252525] p-2">
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<button
							type="button"
							onClick={() => {
								setShowInfo(!showInfo);
								setShowChapters(false);
								setShowMenu(false);
							}}
							className="rounded p-1 text-blue-400 transition-colors hover:bg-gray-700"
							title="情報"
							disabled={!hasActivePlayer}
						>
							<Info size={18} />
						</button>
						<div className="flex min-w-0 flex-1 items-center gap-1">
							{hasActivePlayer && isLive && (
								<div
									className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-bold transition-colors ${
										wsStatus === "connected"
											? "bg-green-600/20 text-green-400"
											: wsStatus === "connecting"
												? "animate-pulse bg-yellow-600/20 text-yellow-500"
												: "bg-red-600/20 text-red-500"
									}`}
									title={`Live Connection: ${wsStatus}`}
								>
									<span>{wsStatus ? STATUS_LABELS[wsStatus] : ""}</span>
								</div>
							)}
							{jkContext && (
								<div className="flex min-w-0 flex-1 items-center gap-2">
									<div
										className="shrink-0 text-sm text-gray-200"
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
											className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-gray-500 border-t-transparent"
											title={
												statusText ||
												channelDisplayState.message ||
												"読み込み中"
											}
										/>
									)}
								</div>
							)}
							{!jkContext && channelDisplayState.message && (
								<div
									className="flex min-w-0 flex-1 items-center gap-2"
									title={channelDisplayState.message}
								>
									<div className="min-w-0 flex-1 truncate text-sm text-gray-400">
										{channelDisplayState.message}
									</div>
									{channelDisplayState.isLoading && (
										<div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-gray-500 border-t-transparent" />
									)}
								</div>
							)}
						</div>
					</div>
					<div className="flex shrink-0 gap-2">
						{hasActivePlayer && !isLive && (
							<button
								type="button"
								onClick={() => {
									setShowChapters(!showChapters);
									setShowMenu(false);
									setShowInfo(false);
								}}
								className={`rounded p-1 transition-colors hover:bg-gray-700 ${
									showChapters ? "bg-gray-700 text-blue-400" : "text-gray-400"
								}`}
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
							className={`rounded p-1 transition-colors hover:bg-gray-700 ${
								showMenu ? "bg-gray-700 text-blue-400" : "text-gray-400"
							}`}
							title="メニュー"
						>
							<MoreVertical size={20} />
						</button>
					</div>
				</div>
			</div>

			<div
				ref={scrollContainerRef}
				className="relative flex-1 overflow-y-auto p-2"
				onScroll={handleScroll}
			>
				{!hasActivePlayer ? (
					<div className="flex h-full flex-col items-center justify-center p-4">
						<MessageSquare size={48} className="mb-4 text-gray-600" />
						<p className="text-sm text-gray-400">プレイヤーを待機中…</p>
						<p className="mt-2 text-center text-[10px] text-gray-600">
							プレイヤーを操作するとコメントが表示されます
						</p>
					</div>
				) : displayComments.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center p-4">
						<MessageSquare size={42} className="mb-3 text-gray-700" />
						<p className="text-sm text-gray-500">
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
							const scrollTop = scrollContainerRef.current?.scrollTop || 0;
							const containerHeight =
								scrollContainerRef.current?.clientHeight || 0;
							const visibleRowTop = virtualRow.start - scrollTop;
							const rowHeight = virtualRow.size || 56;
							const visibleRowBottom = visibleRowTop + rowHeight;
							const spaceAbove = Math.max(
								visibleRowTop - TOOLTIP_SAFE_MARGIN,
								0,
							);
							const spaceBelow = Math.max(
								containerHeight - visibleRowBottom - TOOLTIP_SAFE_MARGIN,
								0,
							);
							const placeAbove =
								spaceBelow < TOOLTIP_MIN_HEIGHT && spaceAbove > spaceBelow;
							const availableHeight = Math.max(
								(placeAbove ? spaceAbove : spaceBelow) - TOOLTIP_SAFE_MARGIN,
								120,
							);
							const mailCommands = [...new Set(c.mail.filter(Boolean))].filter(
								(mail) =>
									!IGNORE_COMMANDS.includes(mail) && !mail.startsWith("nico:"),
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
												<div className="flex w-8 flex-shrink-0 flex-col items-end text-right text-[10px] leading-none text-gray-500 tabular-nums">
													<span>{c.no}</span>
													{!isLive && (
														<span className="mt-0.5 text-[8px] text-gray-600">
															{formatPlaybackTime(c.vpos)}
														</span>
													)}
												</div>
												<div className="flex min-w-0 flex-1 items-center gap-2 self-center">
													<div className="min-w-0 flex-1 break-words leading-[1.5]">
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
												<div
													className={`absolute inset-x-2 z-10 rounded-md border border-gray-600 bg-[#101010] p-2 text-[10px] text-gray-200 shadow-2xl ${
														placeAbove ? "bottom-full mb-1" : "top-full mt-1"
													}`}
													style={{
														maxHeight: `${availableHeight}px`,
														overflowY: "auto",
													}}
												>
													<div className="flex items-center justify-between gap-2 text-gray-300">
														<span>No.{c.no}</span>
														<span>{formatCommentTimestamp(c)}</span>
													</div>
													<div className="mt-1 break-words text-white">
														{c.content}
													</div>
													<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-400">
														<span>ID: {c.user_id || "-"}</span>
														{c.user_id && (
															<button
																type="button"
																onClick={(event) => {
																	event.stopPropagation();
																	handleNGId(c.user_id);
																}}
																className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 transition-colors hover:bg-red-500/20"
																title={`ID: ${c.user_id} をNGに追加`}
															>
																<span className="inline-flex items-center gap-1">
																	<UserX size={12} />
																	ID を NG
																</span>
															</button>
														)}
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
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{hasActivePlayer && showScrollTop && (
				<button
					type="button"
					onClick={scrollToBottom}
					className="absolute bottom-4 right-4 z-10 rounded-full bg-blue-600 p-3 text-white shadow-2xl transition-all duration-200 hover:scale-110 hover:bg-blue-500 active:scale-95 animate-in fade-in zoom-in"
					title="最新へ戻る"
				>
					<ArrowUp size={20} className="rotate-180" />
				</button>
			)}

			{hasActivePlayer && !isLive && showChapters && (
				<div className="absolute inset-x-2 top-12 z-50 rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl duration-200 animate-in fade-in slide-in-from-top-2">
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

			{hasActivePlayer && showMenu && (
				<div className="absolute inset-x-2 top-12 z-50 rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl duration-200 animate-in fade-in slide-in-from-top-2">
					<div className="mb-4 flex items-start justify-between">
						<h4 className="flex items-center gap-1 font-bold text-gray-200">
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
							className="flex w-full items-center justify-between rounded p-2 text-sm transition-colors hover:bg-gray-700"
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
							className="flex w-full items-center justify-between rounded p-2 text-sm transition-colors hover:bg-gray-700"
						>
							<div className="flex items-center gap-2">
								<Ban size={16} />
								<span>NGフィルター</span>
							</div>
							{filterNG && <Check size={16} className="text-red-400" />}
						</button>
						<div className="mx-1 mt-1 border-t border-gray-700 pt-3">
							<div className="mb-2 flex justify-between text-xs">
								<span className="font-medium text-gray-400">
									コメントの濃度
								</span>
								<span className="font-mono text-blue-400">
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
								className="mb-1 h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-gray-700 accent-blue-500"
							/>
						</div>
					</div>
				</div>
			)}

			{hasActivePlayer && showInfo && (
				<div className="absolute inset-x-2 top-12 z-50 flex max-h-[70%] flex-col overflow-hidden rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl duration-200 animate-in fade-in slide-in-from-top-2">
					<div className="mb-2 flex items-start justify-between">
						<h4 className="flex items-center gap-1 font-bold text-blue-400">
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
					{!isLive && (
						<div className="mb-2 flex justify-between text-sm">
							<span className="text-gray-400">取得コメント数</span>
							<span className="tabular-nums text-blue-300">
								{fetchedCommentCount}件
							</span>
						</div>
					)}
					<div className="min-h-0 overflow-y-auto pr-1">
						{jkContext ? (
							<div className="space-y-2 text-sm">
								<div className="border-b border-gray-700 pb-1">
									<div className="mb-2 flex items-center justify-between gap-3">
										<div className="text-gray-400">コメントソース一覧</div>
										<button
											type="button"
											onClick={handleShowAllSources}
											disabled={allSourcesVisible}
											className={`shrink-0 rounded px-2 py-1 text-[10px] transition-colors ${
												allSourcesVisible
													? "cursor-default bg-gray-700 text-gray-500"
													: "bg-blue-600 text-white hover:bg-blue-500"
											}`}
											title="全てのソースを表示"
											aria-label="全てのソースを表示"
										>
											全て表示
										</button>
									</div>
									<div className="space-y-2 text-xs">
										{jkContext.sources.map((source, index) => {
											const sourceCount = sourceCommentCounts.get(index) || 0;
											const isSourceVisible = isSourceKeyVisible(
												visibleSourceKeys,
												source.key,
											);
											const isOnlySourceVisible = isOnlySourceVisibleState(
												visibleSourceKeys,
												source.key,
											);

											return (
												<div
													key={source.key}
													className={`flex items-center justify-between gap-3 rounded-md px-2.5 py-2 ${
														isSourceVisible
															? "border border-blue-500/30 bg-blue-500/10"
															: "bg-[#2a2a2a] opacity-60"
													}`}
												>
													<div className="min-w-0 flex-1">
														<div className="flex min-w-0 items-center gap-2 text-gray-300">
															<span
																className={`inline-flex h-5 shrink-0 items-center justify-center rounded-full border px-1.5 text-[10px] leading-none ${SOURCE_KIND_BADGE_CLASSES[source.kind]}`}
															>
																{SOURCE_KIND_LABELS[source.kind]}
															</span>
															<span className="truncate">
																{source.channelName} ({source.jkId})
															</span>
															{!isLive && (
																<span className="shrink-0 text-gray-500">
																	{sourceCount}件
																</span>
															)}
														</div>
														{!isLive && (
															<div className="text-gray-400">
																{formatTimeRange(source.startAt, source.endAt)}
															</div>
														)}
													</div>
													<div className="flex shrink-0 items-center gap-2 self-center">
														{canShowOnlySource && (
															<button
																type="button"
																onClick={() => handleShowOnlySource(source.key)}
																disabled={isOnlySourceVisible}
																className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
																	isOnlySourceVisible
																		? "cursor-default border-blue-500/40 bg-blue-600 text-white"
																		: "border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600"
																}`}
																title={
																	isOnlySourceVisible
																		? "このソースのみ表示中"
																		: "このソースのみ表示"
																}
																aria-label={
																	isOnlySourceVisible
																		? `${source.channelName} はこのソースのみ表示中`
																		: `${source.channelName} のみ表示`
																}
															>
																<Filter size={14} />
															</button>
														)}
														<button
															type="button"
															onClick={() =>
																handleToggleSourceVisibility(source.key)
															}
															className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
																isSourceVisible
																	? "border-blue-500/40 bg-blue-600 text-white hover:bg-blue-500"
																	: "border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600"
															}`}
															title={
																isSourceVisible ? "非表示にする" : "表示する"
															}
															aria-label={
																isSourceVisible
																	? `${source.channelName} を非表示にする`
																	: `${source.channelName} を表示する`
															}
														>
															{isSourceVisible ? (
																<CircleMinus size={14} />
															) : (
																<CirclePlus size={14} />
															)}
														</button>
													</div>
												</div>
											);
										})}
									</div>
								</div>
							</div>
						) : (
							<p className="text-sm italic text-gray-500">
								情報が取得できませんでした
							</p>
						)}
					</div>
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

function isSourceKeyVisible(
	visibleSourceKeys: string[] | null,
	sourceKey: string,
) {
	return visibleSourceKeys == null || visibleSourceKeys.includes(sourceKey);
}

function isOnlySourceVisibleState(
	visibleSourceKeys: string[] | null,
	sourceKey: string,
) {
	return (
		visibleSourceKeys != null &&
		visibleSourceKeys.length === 1 &&
		visibleSourceKeys[0] === sourceKey
	);
}

function areAllSourcesVisible(
	visibleSourceKeys: string[] | null,
	jkContext: NicoJKContext | null,
) {
	if (!jkContext) {
		return true;
	}
	if (visibleSourceKeys == null) {
		return true;
	}

	return jkContext.sources.every((source) =>
		visibleSourceKeys.includes(source.key),
	);
}

function toggleSourceVisibility(
	visibleSourceKeys: string[] | null,
	sourceKey: string,
	jkContext: NicoJKContext,
) {
	const sourceKeysInOrder = jkContext.sources.map((source) => source.key);

	if (visibleSourceKeys == null) {
		return sourceKeysInOrder.filter((key) => key !== sourceKey);
	}

	if (visibleSourceKeys.includes(sourceKey)) {
		return visibleSourceKeys.filter((key) => key !== sourceKey);
	}

	const nextVisibleSourceKeys = sourceKeysInOrder.filter(
		(key) => key === sourceKey || visibleSourceKeys.includes(key),
	);

	return nextVisibleSourceKeys.length === sourceKeysInOrder.length
		? null
		: nextVisibleSourceKeys;
}
