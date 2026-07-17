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
	RotateCw,
	Search,
	UserX,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayerPlaybackState } from "../../../Plugin";
import type { ConnectionStatus, NiconicoComment } from "../comment-client";
import type { NicoJKContext } from "../context";
import type { InterruptedSourceInfo } from "../kakolog-manager";
import {
	addNGCommand,
	addNGId,
	getSettings,
	SETTINGS_UPDATED_EVENT,
	saveSettings,
} from "../ng-settings";

const CHAPTER_LABELS = [
	"A",
	"B",
	"C",
	"D",
	"OP",
	"ED",
	"ここ",
	"出OP",
] as const;
const IGNORE_COMMANDS = ["184", "medium", "naka", "white"];
const SHEET_ANIMATION_MS = 240;
const ROW_ESTIMATE_SIZE = 41;

type ChapterLabel = (typeof CHAPTER_LABELS)[number];

type ChapterPoint = {
	key: string;
	label: ChapterLabel;
	relativeSec: number;
};

interface Props {
	comments: NiconicoComment[];
	visibleSourceKeys: string[] | null;
	onVisibleSourceKeysChange: (sourceKeys: string[] | null) => void;
	onResumeSource: (sourceKey: string) => void;
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
	interruptedSources: InterruptedSourceInfo[];
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

export default function PanelPage({
	comments,
	visibleSourceKeys,
	onVisibleSourceKeysChange,
	onResumeSource,
	isLive,
	duration,
	playbackState,
	wsStatus,
	jkContext,
	channelDisplayState,
	interruptedSources,
	hasActivePlayer,
}: Props) {
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [filterNG, setFilterNG] = useState(true);
	const [showChapters, setShowChapters] = useState(false);
	const [showInfo, setShowInfo] = useState(false);
	const [showMenu, setShowMenu] = useState(false);
	const [showSearch, setShowSearch] = useState(false);
	const chaptersPopup = useAnimatedVisibility(showChapters);
	const infoPopup = useAnimatedVisibility(showInfo);
	const menuPopup = useAnimatedVisibility(showMenu);
	const searchPopup = useAnimatedVisibility(showSearch);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(-1);
	const [settings, setSettings] = useState(getSettings());
	const [pinnedCommentId, setPinnedCommentId] = useState<number | null>(null);
	const [buttonRendered, setButtonRendered] = useState(false);
	const [buttonShown, setButtonShown] = useState(false);
	const [sheetRendered, setSheetRendered] = useState(false);
	const [sheetShown, setSheetShown] = useState(false);
	const chapterWindowSeconds = settings.chapterWindowSeconds;
	const chapterCooldownSeconds = settings.chapterCooldownSeconds;
	const chapterMinimumCount = settings.chapterMinimumCount;
	const chapterSeekLeadSeconds = settings.chapterSeekLeadSeconds;
	const [safeAreaInsetBottom, setSafeAreaInsetBottom] = useState(
		() =>
			parseFloat(
				getComputedStyle(document.documentElement).getPropertyValue(
					"--kiririn-safe-area-inset-bottom",
				) || "0",
			) + 6,
	);
	useEffect(() => {
		const update = () => {
			setSafeAreaInsetBottom(
				parseFloat(
					getComputedStyle(document.documentElement).getPropertyValue(
						"--kiririn-safe-area-inset-bottom",
					) || "0",
				) + 6,
			);
		};
		const observer = new ResizeObserver(update);
		observer.observe(document.documentElement);
		return () => observer.disconnect();
	}, []);
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
			? comments.filter((comment) => {
					if (comment.user_id && settings.ngIds.includes(comment.user_id)) {
						return false;
					}
					if (
						comment.content &&
						settings.ngWords.some((word) => comment.content.includes(word))
					) {
						return false;
					}
					return true;
				})
			: comments;
		return ngFiltered.filter((comment) =>
			isCommentVisibleForSource(comment, jkContext, visibleSourceKeys),
		);
	}, [
		comments,
		filterNG,
		jkContext,
		settings.ngIds,
		settings.ngWords,
		visibleSourceKeys,
	]);

	const displayComments = filteredComments;
	const normalizedSearchQuery = useMemo(
		() => searchQuery.trim().toLocaleLowerCase(),
		[searchQuery],
	);
	const matchedCommentIndexes = useMemo(() => {
		if (!normalizedSearchQuery) {
			return [];
		}

		const indexes: number[] = [];
		for (const [index, comment] of displayComments.entries()) {
			if (comment.content.toLocaleLowerCase().includes(normalizedSearchQuery)) {
				indexes.push(index);
			}
		}
		return indexes;
	}, [displayComments, normalizedSearchQuery]);
	const matchedCommentIndexSet = useMemo(
		() => new Set(matchedCommentIndexes),
		[matchedCommentIndexes],
	);
	const activeSearchCommentIndex =
		activeSearchMatchIndex >= 0
			? (matchedCommentIndexes[activeSearchMatchIndex] ?? -1)
			: -1;
	const activeSearchResultNumber =
		activeSearchCommentIndex >= 0 ? activeSearchMatchIndex + 1 : 0;
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

		return filtered.reverse();
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
	const playbackProgress =
		duration > 0 ? clamp((playbackState?.time ?? 0) / duration, 0, 1) : 0;
	const buttonVisible =
		hasActivePlayer && !autoScroll && displayComments.length > 0;
	const sheetVisible = pinnedCommentId != null;
	const activeTooltip = useMemo(() => {
		if (pinnedCommentId == null) {
			return null;
		}
		const comment = displayComments.find((c) => c.id === pinnedCommentId);
		if (!comment) {
			return null;
		}
		const sourceOrdinal = Math.max(comment.sourceOrdinal || 0, 0);
		const commentSource = jkContext?.sources[sourceOrdinal] || null;
		const mailCommands = [...new Set(comment.mail.filter(Boolean))].filter(
			(mail) => !IGNORE_COMMANDS.includes(mail) && !mail.startsWith("nico:"),
		);
		return { comment, sourceOrdinal, commentSource, mailCommands };
	}, [displayComments, jkContext, pinnedCommentId]);
	const [renderedTooltip, setRenderedTooltip] = useState<NonNullable<
		typeof activeTooltip
	> | null>(null);

	const rowVirtualizer = useVirtualizer({
		count: hasActivePlayer ? displayComments.length : 0,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => ROW_ESTIMATE_SIZE,
		overscan: 10,
		getItemKey: (index) => {
			const item = displayComments[index];
			return item ? `${item.no}-${item.id}` : index;
		},
		paddingEnd: safeAreaInsetBottom,
		scrollPaddingEnd: safeAreaInsetBottom + 4,
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
			rowVirtualizer.scrollToEnd({ behavior: "auto" });
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
		if (targetIndex < 0) {
			return;
		}
		rowVirtualizer.scrollToIndex(targetIndex, {
			align: "end",
			behavior: "auto",
		});
	}, [
		autoScroll,
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

	const scrollToBottom = useCallback(() => {
		lastScrolledTimeRef.current = 0;
		setAutoScroll(true);
	}, []);

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

	const dismissSheet = useCallback(() => {
		setPinnedCommentId(null);
	}, []);

	const togglePinComment = useCallback((commentId: number) => {
		setPinnedCommentId((current) => (current === commentId ? null : commentId));
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

	const moveSearchMatch = useCallback(
		(direction: -1 | 1) => {
			if (matchedCommentIndexes.length === 0) {
				return;
			}

			setActiveSearchMatchIndex((current) => {
				const baseIndex =
					current >= 0 && current < matchedCommentIndexes.length
						? current
						: direction > 0
							? -1
							: 0;
				return wrapIndex(baseIndex + direction, matchedCommentIndexes.length);
			});
		},
		[matchedCommentIndexes],
	);

	const handleSearchInputKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Enter") {
				event.preventDefault();
				moveSearchMatch(event.shiftKey ? -1 : 1);
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				setShowSearch(false);
			}
		},
		[moveSearchMatch],
	);

	useEffect(() => {
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
		setActiveSearchMatchIndex((current) => {
			if (matchedCommentIndexes.length === 0) {
				return -1;
			}
			if (current >= 0 && current < matchedCommentIndexes.length) {
				return current;
			}
			return 0;
		});
	}, [matchedCommentIndexes]);

	useEffect(() => {
		if (isLive || !hasActivePlayer) {
			setShowChapters(false);
		}
	}, [hasActivePlayer, isLive]);

	useEffect(() => {
		if (!showSearch) {
			return;
		}

		searchInputRef.current?.focus();
		searchInputRef.current?.select();
	}, [showSearch]);

	useEffect(() => {
		if (!showSearch || activeSearchCommentIndex < 0) {
			return;
		}

		setAutoScroll(false);
		rowVirtualizer.scrollToIndex(activeSearchCommentIndex, {
			align: "center",
			behavior: "auto",
		});
	}, [activeSearchCommentIndex, rowVirtualizer, showSearch]);

	useEffect(() => {
		if (buttonVisible) {
			setButtonRendered(true);
			const enterTimer = window.setTimeout(() => setButtonShown(true), 16);
			return () => window.clearTimeout(enterTimer);
		}
		setButtonShown(false);
		const exitTimer = window.setTimeout(
			() => setButtonRendered(false),
			SHEET_ANIMATION_MS,
		);
		return () => window.clearTimeout(exitTimer);
	}, [buttonVisible]);

	useEffect(() => {
		if (sheetVisible) {
			setSheetRendered(true);
			const enterTimer = window.setTimeout(() => setSheetShown(true), 16);
			return () => window.clearTimeout(enterTimer);
		}
		setSheetShown(false);
		const exitTimer = window.setTimeout(
			() => setSheetRendered(false),
			SHEET_ANIMATION_MS,
		);
		return () => window.clearTimeout(exitTimer);
	}, [sheetVisible]);

	useEffect(() => {
		if (activeTooltip) {
			setRenderedTooltip(activeTooltip);
		} else if (!sheetRendered) {
			setRenderedTooltip(null);
		}
	}, [activeTooltip, sheetRendered]);

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
			const seekTime = clamp(
				chapter.relativeSec - chapterSeekLeadSeconds,
				0,
				duration,
			);
			if (typeof window.kiririn.seekToTime === "function") {
				window.kiririn.seekToTime(seekTime, playbackState?.playerID);
			} else {
				window.kiririn.seek(seekTime / duration, playbackState?.playerID);
			}
		},
		[
			canSeekToChapters,
			chapterSeekLeadSeconds,
			duration,
			playbackState?.playerID,
		],
	);

	const handleSeekToComment = useCallback(
		(comment: NiconicoComment) => {
			if (isLive || duration <= 0) {
				return;
			}

			const relativeSec = comment.vpos / 100 - (jkContext?.startAt ?? 0);
			if (!Number.isFinite(relativeSec) || relativeSec < 0) {
				return;
			}

			const seekTime = clamp(relativeSec, 0, duration);
			lastScrolledTimeRef.current = 0;
			setAutoScroll(true);
			if (typeof window.kiririn.seekToTime === "function") {
				window.kiririn.seekToTime(seekTime, playbackState?.playerID);
			} else {
				window.kiririn.seek(seekTime / duration, playbackState?.playerID);
			}
		},
		[duration, isLive, jkContext?.startAt, playbackState?.playerID],
	);

	return (
		<div className="relative flex h-screen flex-col overflow-hidden bg-[#1a1a1a] text-white">
			<div className="shrink-0 border-b border-gray-700 bg-[#252525] p-2">
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<button
							type="button"
							onClick={() => {
								setShowInfo(!showInfo);
								setShowChapters(false);
								setShowMenu(false);
								setShowSearch(false);
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
						<button
							type="button"
							onClick={() => {
								setShowSearch(!showSearch);
								setShowMenu(false);
								setShowChapters(false);
								setShowInfo(false);
							}}
							disabled={!hasActivePlayer}
							className={`rounded p-1 transition-colors hover:bg-gray-700 ${
								showSearch ? "bg-gray-700 text-blue-400" : "text-gray-400"
							}`}
							title="コメント検索"
						>
							<Search size={20} />
						</button>
						{hasActivePlayer && !isLive && (
							<button
								type="button"
								onClick={() => {
									setShowChapters(!showChapters);
									setShowMenu(false);
									setShowInfo(false);
									setShowSearch(false);
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
								setShowSearch(false);
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
							const isSearchMatched = matchedCommentIndexSet.has(
								virtualRow.index,
							);
							const isActiveSearchMatch =
								activeSearchCommentIndex === virtualRow.index;
							const isActiveTooltipRow = pinnedCommentId === c.id;

							return (
								<button
									key={virtualRow.key}
									ref={rowVirtualizer.measureElement}
									data-index={virtualRow.index}
									data-vpos={c.vpos}
									data-comment-id={c.id}
									type="button"
									onClick={() => togglePinComment(c.id)}
									style={{
										position: "absolute",
										top: virtualRow.start,
										left: 0,
										width: "100%",
									}}
									className="cursor-pointer appearance-none border-0 bg-transparent p-0 text-left text-inherit focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
								>
									<div
										className={`group relative mb-1 flex items-center gap-2 rounded p-2 text-sm leading-relaxed transition-colors ${
											isActiveSearchMatch
												? "bg-amber-500/20 ring-1 ring-amber-400/60 hover:bg-amber-500/25"
												: isSearchMatched
													? "bg-amber-500/10 hover:bg-amber-500/15"
													: isActiveTooltipRow
														? "bg-[#333]"
														: "hover:bg-[#2c2c2c]"
										}`}
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
											{isSearchMatched && (
												<span
													className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${
														isActiveSearchMatch
															? "bg-amber-400/25 text-amber-100"
															: "bg-amber-400/15 text-amber-200"
													}`}
												>
													検索
												</span>
											)}
											{isSecondarySource && (
												<span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] text-blue-200">
													{commentSource
														? SOURCE_KIND_LABELS[commentSource.kind]
														: `src${sourceOrdinal + 1}`}
												</span>
											)}
										</div>
									</div>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{buttonRendered && (
				<button
					type="button"
					onClick={scrollToBottom}
					style={{
						bottom: "calc(1rem + var(--kiririn-safe-area-inset-bottom))",
					}}
					className={`absolute right-4 z-10 rounded-md bg-gray-600 px-4 py-2 text-sm font-medium text-white shadow-2xl transition-all duration-200 ease-out hover:bg-blue-500 active:scale-95 ${
						buttonShown
							? "translate-y-0 opacity-100"
							: "pointer-events-none translate-y-2 opacity-0"
					}`}
				>
					再生位置に戻る
				</button>
			)}
			{sheetRendered && renderedTooltip && (
				<>
					<button
						type="button"
						aria-label="シートを閉じる"
						onClick={(event) => {
							event.stopPropagation();
							dismissSheet();
						}}
						className={`absolute inset-0 z-60 bg-black/55 transition-opacity duration-200 ease-out ${
							sheetShown ? "opacity-100" : "opacity-0"
						}`}
					/>
					<div
						role="dialog"
						aria-modal="true"
						className="absolute inset-x-0 bottom-0 z-70 flex max-h-[80%] flex-col rounded-t-2xl border-t border-gray-700 bg-[#1f1f1f] text-white shadow-[0_-12px_32px_rgba(0,0,0,0.55)] transition-transform duration-200 ease-out"
						style={{
							transform: sheetShown ? "translateY(0)" : "translateY(100%)",
							paddingBottom:
								"calc(0.5rem + var(--kiririn-safe-area-inset-bottom))",
						}}
					>
						<div className="flex items-start justify-between gap-3 border-b border-gray-800 px-4 pb-3 pt-4">
							<div className="min-w-0">
								<div className="truncate text-[12px] font-semibold text-gray-400">
									No.{renderedTooltip.comment.no}
								</div>
								<div className="mt-0.5 truncate text-[11px] text-gray-400">
									{formatCommentTimestamp(renderedTooltip.comment)}
								</div>
							</div>
							<button
								type="button"
								onClick={dismissSheet}
								className="shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-700 hover:text-white"
								aria-label="シートを閉じる"
							>
								<X size={18} />
							</button>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed break-words text-white">
							{renderedTooltip.comment.content}
						</div>
						<div className="space-y-3 border-t border-gray-800 px-4 py-3 text-[11px] text-gray-300">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
								<span className="text-gray-400">
									ID: {renderedTooltip.comment.user_id || "-"}
								</span>
								{renderedTooltip.comment.user_id && (
									<button
										type="button"
										onClick={() => handleNGId(renderedTooltip.comment.user_id)}
										className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 transition-colors hover:bg-red-500/20"
										title={`ID: ${renderedTooltip.comment.user_id} をNGに追加`}
									>
										<span className="inline-flex items-center gap-1">
											<UserX size={12} />
											ID を NG
										</span>
									</button>
								)}
								{!isLive && (
									<>
										<span className="text-gray-400">
											再生位置:{" "}
											{formatPlaybackTime(renderedTooltip.comment.vpos)}
										</span>
										<button
											type="button"
											onClick={() =>
												handleSeekToComment(renderedTooltip.comment)
											}
											disabled={
												duration <= 0 ||
												renderedTooltip.comment.vpos / 100 -
													(jkContext?.startAt ?? 0) <
													0
											}
											className="rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[10px] text-blue-200 transition-colors hover:bg-blue-500/20 disabled:cursor-default disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500"
											title="このコメントの再生位置へシーク"
										>
											このコメントへシーク
										</button>
									</>
								)}
								<span className="text-gray-500">
									premium: {renderedTooltip.comment.premium}
								</span>
							</div>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-400">
								<span>
									ソース:{" "}
									{renderedTooltip.commentSource
										? formatSourceLabel(renderedTooltip.commentSource)
										: `src${renderedTooltip.sourceOrdinal + 1}`}
								</span>
								{renderedTooltip.commentSource && (
									<span>
										種別:{" "}
										{SOURCE_KIND_LABELS[renderedTooltip.commentSource.kind]}
									</span>
								)}
							</div>
							{renderedTooltip.mailCommands.length > 0 && (
								<div>
									<div className="mb-1.5 text-gray-400">コマンド</div>
									<div className="flex flex-wrap gap-1.5">
										{renderedTooltip.mailCommands.map((command) => {
											const isNGCommand = settings.ngCommands.includes(command);
											return (
												<button
													key={command}
													type="button"
													onClick={() => handleNGCommand(command)}
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
								</div>
							)}
						</div>
					</div>
				</>
			)}

			{hasActivePlayer && searchPopup.rendered && (
				<div
					className={`absolute right-2 top-12 z-50 w-[min(28rem,calc(100%-1rem))] rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl transition-all duration-200 ease-out ${
						searchPopup.shown
							? "translate-y-0 opacity-100"
							: "pointer-events-none -translate-y-2 opacity-0"
					}`}
				>
					<div className="mb-3 flex items-start justify-between gap-3">
						<h4 className="flex items-center gap-2 font-bold text-gray-100">
							<Search size={14} /> コメント検索
						</h4>
						<button
							type="button"
							onClick={() => setShowSearch(false)}
							className="text-gray-400 hover:text-white"
						>
							<X size={16} />
						</button>
					</div>
					<div className="flex items-center gap-2">
						<div className="relative min-w-0 flex-1">
							<Search
								size={14}
								className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
							/>
							<input
								ref={searchInputRef}
								type="text"
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								onKeyDown={handleSearchInputKeyDown}
								placeholder="コメントを検索"
								className="w-full rounded-md border border-gray-600 bg-[#1f1f1f] py-2 pl-9 pr-3 text-base text-white outline-none transition-colors placeholder:text-gray-500 focus:border-blue-500"
							/>
						</div>
						<button
							type="button"
							onClick={() => moveSearchMatch(-1)}
							disabled={matchedCommentIndexes.length === 0}
							className={`flex h-9 w-9 items-center justify-center rounded border transition-colors ${
								matchedCommentIndexes.length === 0
									? "cursor-default border-gray-700 bg-[#2a2a2a] text-gray-600"
									: "border-gray-600 bg-[#1f1f1f] text-gray-200 hover:bg-gray-700"
							}`}
							title="前の検索結果へ移動 (Shift+Enter)"
						>
							<ArrowUp size={16} />
						</button>
						<button
							type="button"
							onClick={() => moveSearchMatch(1)}
							disabled={matchedCommentIndexes.length === 0}
							className={`flex h-9 w-9 items-center justify-center rounded border transition-colors ${
								matchedCommentIndexes.length === 0
									? "cursor-default border-gray-700 bg-[#2a2a2a] text-gray-600"
									: "border-gray-600 bg-[#1f1f1f] text-gray-200 hover:bg-gray-700"
							}`}
							title="次の検索結果へ移動 (Enter)"
						>
							<ArrowDown size={16} />
						</button>
					</div>
					<div className="mt-3 flex items-center justify-between gap-3 text-xs">
						<div className="min-w-0">
							<div className="font-mono text-blue-300">
								{activeSearchResultNumber}/{matchedCommentIndexes.length}件
							</div>
							<div className="truncate text-gray-400">
								{normalizedSearchQuery
									? matchedCommentIndexes.length > 0
										? ""
										: "検索結果がありません"
									: "現在表示中のコメントを部分一致で検索します"}
							</div>
						</div>
						<button
							type="button"
							onClick={() => {
								setSearchQuery("");
								setActiveSearchMatchIndex(-1);
								searchInputRef.current?.focus();
							}}
							disabled={searchQuery.length === 0}
							className={`shrink-0 rounded px-2 py-1 transition-colors ${
								searchQuery.length === 0
									? "cursor-default text-gray-600"
									: "text-gray-300 hover:bg-gray-700 hover:text-white"
							}`}
						>
							クリア
						</button>
					</div>
				</div>
			)}

			{hasActivePlayer && !isLive && chaptersPopup.rendered && (
				<div
					className={`absolute inset-x-2 top-12 z-50 rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl transition-all duration-200 ease-out ${
						chaptersPopup.shown
							? "translate-y-0 opacity-100"
							: "pointer-events-none -translate-y-2 opacity-0"
					}`}
				>
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
											style={{
												left: `${clamp(chapter.relativeSec / duration, 0, 1) * 100}%`,
											}}
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

			{hasActivePlayer && menuPopup.rendered && (
				<div
					className={`absolute inset-x-2 top-12 z-50 rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl transition-all duration-200 ease-out ${
						menuPopup.shown
							? "translate-y-0 opacity-100"
							: "pointer-events-none -translate-y-2 opacity-0"
					}`}
				>
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
							onClick={() =>
								setSettings(
									saveSettings({
										...settings,
										showComments: !settings.showComments,
									}),
								)
							}
							className="flex w-full items-center justify-between rounded p-2 text-sm transition-colors hover:bg-gray-700"
						>
							<div className="flex items-center gap-2">
								<MessageSquare size={16} />
								<span>コメントを表示する</span>
							</div>
							{settings.showComments && (
								<Check size={16} className="text-blue-400" />
							)}
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

			{hasActivePlayer && infoPopup.rendered && (
				<div
					className={`absolute inset-x-2 top-12 z-50 flex max-h-[70%] flex-col overflow-hidden rounded-lg border border-gray-600 bg-[#333] p-4 shadow-2xl transition-all duration-200 ease-out ${
						infoPopup.shown
							? "translate-y-0 opacity-100"
							: "pointer-events-none -translate-y-2 opacity-0"
					}`}
				>
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
											const interruptedInfo = interruptedSources.find(
												(info) => info.sourceKey === source.key,
											);
											const isInterrupted = interruptedInfo != null;
											const isFullyUnfetched =
												isInterrupted &&
												(interruptedInfo?.fetchedChunkCount || 0) === 0;
											const interruptedChunks = interruptedInfo?.chunks || [];

											return (
												<div
													key={source.key}
													className={`flex items-center justify-between gap-3 rounded-md px-2.5 py-2 ${
														isInterrupted
															? "border border-amber-500/30 bg-amber-500/10"
															: isSourceVisible
																? "border border-blue-500/30 bg-blue-500/10"
																: "bg-[#2a2a2a] opacity-60"
													}`}
												>
													<div
														className={`min-w-0 flex-1 ${isFullyUnfetched ? "opacity-50" : ""}`}
													>
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
															{isInterrupted && (
																<span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-200">
																	部分取得
																</span>
															)}
														</div>
														{!isLive && (
															<div className="text-gray-400">
																{formatTimeRange(source.startAt, source.endAt)}
															</div>
														)}
														{isInterrupted && interruptedChunks.length > 0 && (
															<div className="mt-1.5 flex items-center gap-1">
																{interruptedChunks.map((chunk) => {
																	const chunkLabel = `${formatTimeRange(chunk.startAt, chunk.endAt)}`;
																	return (
																		<span
																			key={chunk.startAt}
																			className={`inline-block h-2 w-2 rounded-full ${
																				chunk.fetched
																					? "bg-amber-400"
																					: "bg-gray-600"
																			}`}
																			title={
																				chunk.fetched
																					? `取得済: ${chunkLabel}`
																					: `未取得: ${chunkLabel}`
																			}
																		/>
																	);
																})}
																<span className="ml-1 text-[9px] text-amber-300/70">
																	{interruptedInfo?.fetchedChunkCount || 0}/
																	{interruptedInfo?.totalChunkCount || 0}
																</span>
															</div>
														)}
													</div>
													<div className="flex shrink-0 items-center gap-2 self-center">
														{isInterrupted && (
															<button
																type="button"
																onClick={() => onResumeSource(source.key)}
																className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-600/80 px-2 py-1 text-[10px] text-white transition-colors hover:bg-amber-500"
																title={`${source.channelName} の取得を再開`}
																aria-label={`${source.channelName} の取得を再開`}
															>
																<RotateCw size={12} />
																全件取得
															</button>
														)}
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

function wrapIndex(index: number, total: number) {
	if (total <= 0) {
		return -1;
	}

	return ((index % total) + total) % total;
}

const POPUP_ANIMATION_MS = 180;

function useAnimatedVisibility(visible: boolean) {
	const [rendered, setRendered] = useState(visible);
	const [shown, setShown] = useState(false);

	useEffect(() => {
		if (visible) {
			setRendered(true);
			const enterTimer = window.setTimeout(() => setShown(true), 16);
			return () => window.clearTimeout(enterTimer);
		}
		setShown(false);
		const exitTimer = window.setTimeout(
			() => setRendered(false),
			POPUP_ANIMATION_MS,
		);
		return () => window.clearTimeout(exitTimer);
	}, [visible]);

	return { rendered, shown };
}
