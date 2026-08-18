import {
	type ChapterSourceCorrection,
	synchronizeCommentSourcesByChapters,
} from "./chapter-source-sync";
import type { NiconicoComment } from "./comment-client";
import { buildStableCommentId } from "./comment-id";
import { fetchJson } from "./host-fetch";
import {
	convertMiyouComment,
	fetchMiyouComments,
} from "./miyou-comment-client";
import { getSettings } from "./ng-settings";
import type {
	ResolvedCommentSource,
	ResolvedSourceKind,
} from "./source-resolver";

interface NicoLogComment {
	id: string;
	no: string;
	vpos: string;
	content: string;
	date: string;
	date_usec?: string;
	mail: string;
	user_id: string;
	premium?: string;
	anonymity?: string;
}

interface KakologResponse {
	packet: { chat: NicoLogComment }[];
}

export interface KakologFetchProgress {
	currentSourceJkId: string | null;
	currentSourceChannelName: string | null;
	currentRequest: number;
	totalRequests: number;
	remainingRequests: number;
	fetchedComments: number;
}

// 1860 秒（31分）ごとに区切って取得する
const KAKOLOG_CHUNK_SIZE = 1860;

// 1 度の取得バッチで最大何件までコメントを読み込むか
const MAX_FETCH_COMMENTS = 10000;

// 自動再開をトリガーする再生位置の余裕（秒）
const AUTO_RESUME_LEAD_SECONDS = 60;

export interface InterruptedChunkState {
	/** チャンクの開始 unixtime */
	startAt: number;
	/** チャンクの終了 unixtime */
	endAt: number;
	/** 取得済みなら true */
	fetched: boolean;
}

export interface InterruptedSourceInfo {
	sourceKey: string;
	jkId: string;
	channelName: string;
	kind: ResolvedSourceKind;
	commentCount: number;
	/** 取得済みチャンク数（0 の場合は完全未取得） */
	fetchedChunkCount: number;
	/** 対象チャンク総数 */
	totalChunkCount: number;
	/** 取得済み区間の開始 unixtime（完全未取得時は null） */
	fetchedStartAt: number | null;
	/** 取得済み区間の終了 unixtime（完全未取得時は null） */
	fetchedEndAt: number | null;
	/** チャンクごとの取得状態（applicableOffsets 順） */
	chunks: InterruptedChunkState[];
}

export interface ChapterCorrectionInfo {
	sourceKey: string;
	offsetSeconds: number;
	matchedLabels: ChapterSourceCorrection["matchedLabels"];
	enabled: boolean;
}

interface SourceFetchState {
	sourceKey: string;
	sourceOrdinal: number;
	source: ResolvedCommentSource;
	applicableOffsets: number[];
	fetchedOffsets: Set<number>;
	niconicoFetchedOffsets: Set<number>;
	miyouFetchedOffsets: Set<number>;
	needsInitialFetch: boolean;
	completed: boolean;
	interrupted: boolean;
	ignoreLimit: boolean;
	commentCount: number;
}

interface SourceChunkFetchResult {
	comments: NiconicoComment[];
	niconicoFetched: boolean;
	miyouFetched: boolean;
}

function sortAndDedupeComments(comments: NiconicoComment[]) {
	const sorted = [...comments].sort(
		(a, b) =>
			a.vpos - b.vpos ||
			a.date - b.date ||
			a.date_usec - b.date_usec ||
			a.id - b.id,
	);
	const deduped: NiconicoComment[] = [];
	const seen = new Set<number>();
	for (const comment of sorted) {
		if (seen.has(comment.id)) {
			continue;
		}
		seen.add(comment.id);
		deduped.push(comment);
	}
	return deduped;
}

function getChunkOffsets(duration: number) {
	const offsets: number[] = [];
	for (let offset = 0; offset < duration; offset += KAKOLOG_CHUNK_SIZE) {
		offsets.push(offset);
	}
	return offsets;
}

function getPriorityChunkStart(playerTime: number, duration: number) {
	const offsets = getChunkOffsets(duration);
	if (offsets.length === 0) {
		return 0;
	}

	const preferredOffset =
		Math.floor(Math.max(playerTime, 0) / KAKOLOG_CHUNK_SIZE) *
		KAKOLOG_CHUNK_SIZE;
	return Math.min(preferredOffset, offsets[offsets.length - 1]);
}

export class KakologManager {
	private sourceSignature = "";
	private sources: ResolvedCommentSource[] = [];
	private fetchRevision = 0;
	private allComments: NiconicoComment[] = [];
	private sourceStates: SourceFetchState[] = [];
	private totalFetched = 0;
	private batchStartCount = 0;
	private batchLimit = MAX_FETCH_COMMENTS;
	private isFetching = false;
	private pendingMiyouRefresh = false;
	private lastFetchDuration: number | null = null;
	private interruptOffset: number | null = null;
	private progressListener:
		| ((progress: KakologFetchProgress | null) => void)
		| null = null;
	private progressState: {
		totalRequests: number;
		completedRequests: number;
		skippedRequests: number;
		fetchedComments: number;
		currentSourceJkId: string | null;
		currentSourceChannelName: string | null;
	} | null = null;
	private correctionSignature = "";
	private chapterCorrections: ChapterSourceCorrection[] = [];
	private disabledChapterCorrectionSourceKeys = new Set<string>();

	public setSources(sources: ResolvedCommentSource[]) {
		const signature = JSON.stringify(
			sources.map((source) => [
				source.key,
				source.jkId,
				source.startAt,
				source.endAt,
				source.programStartAt,
				source.miyouChannel,
			]),
		);
		if (this.sourceSignature === signature) {
			return;
		}

		if (this.tryAppendSources(sources, signature)) {
			return;
		}

		this.sourceSignature = signature;
		this.sources = sources;
		this.fetchRevision += 1;
		this.allComments = [];
		this.sourceStates = sources.map((source, ordinal) => ({
			sourceKey: source.key,
			sourceOrdinal: ordinal,
			source,
			applicableOffsets: [],
			fetchedOffsets: new Set<number>(),
			niconicoFetchedOffsets: new Set<number>(),
			miyouFetchedOffsets: new Set<number>(),
			needsInitialFetch: false,
			completed: false,
			interrupted: false,
			ignoreLimit: false,
			commentCount: 0,
		}));
		this.totalFetched = 0;
		this.batchStartCount = 0;
		this.batchLimit = MAX_FETCH_COMMENTS;
		this.isFetching = false;
		this.pendingMiyouRefresh = false;
		this.lastFetchDuration = null;
		this.interruptOffset = null;
		this.resetChapterCorrectionState();
		this.resetProgress();
	}

	/**
	 * 既存ソースを新しい配列の先頭に同じ順序で残した追記だけを許可する。
	 * それ以外の変更は setSources の全リセットへ委ねる。
	 */
	private tryAppendSources(
		sources: ResolvedCommentSource[],
		signature: string,
	): boolean {
		if (
			this.sources.length === 0 ||
			sources.length < this.sources.length ||
			!this.sources.every((source, index) => source.key === sources[index]?.key)
		) {
			return false;
		}

		const previousSourceCount = this.sourceStates.length;
		this.sources = sources;
		for (const [sourceOrdinal, source] of sources.entries()) {
			const existingState = this.sourceStates[sourceOrdinal];
			if (existingState) {
				existingState.source = source;
				continue;
			}

			const applicableOffsets =
				this.lastFetchDuration != null
					? getChunkOffsets(this.lastFetchDuration).filter(
							(offset) => offset < source.endAt - source.startAt,
						)
					: [];
			this.sourceStates.push({
				sourceKey: source.key,
				sourceOrdinal,
				source,
				applicableOffsets,
				fetchedOffsets: new Set<number>(),
				niconicoFetchedOffsets: new Set<number>(),
				miyouFetchedOffsets: new Set<number>(),
				needsInitialFetch: true,
				completed: false,
				interrupted: false,
				ignoreLimit: false,
				commentCount: 0,
			});
		}
		this.sourceSignature = signature;

		if (this.isFetching && this.progressState) {
			const addedStates = this.sourceStates.slice(previousSourceCount);
			this.progressState.totalRequests +=
				this.countRemainingRequests(addedStates);
			this.emitProgress();
		}
		return true;
	}

	public clearCache() {
		this.fetchRevision += 1;
		this.allComments = [];
		for (const state of this.sourceStates) {
			state.fetchedOffsets.clear();
			state.niconicoFetchedOffsets.clear();
			state.miyouFetchedOffsets.clear();
			state.needsInitialFetch = false;
			state.completed = false;
			state.interrupted = false;
			state.ignoreLimit = false;
			state.commentCount = 0;
			state.applicableOffsets = [];
		}
		this.totalFetched = 0;
		this.batchStartCount = 0;
		this.batchLimit = MAX_FETCH_COMMENTS;
		this.isFetching = false;
		this.pendingMiyouRefresh = false;
		this.interruptOffset = null;
		this.resetChapterCorrectionState();
		this.resetProgress();
	}

	private resetChapterCorrectionState() {
		this.correctionSignature = "";
		this.chapterCorrections = [];
		this.disabledChapterCorrectionSourceKeys.clear();
	}

	public setProgressListener(
		listener: ((progress: KakologFetchProgress | null) => void) | null,
	) {
		this.progressListener = listener;
		this.emitProgress();
	}

	public getAllComments(): NiconicoComment[] {
		return this.getSynchronizedComments();
	}

	/** 既取得のニコニココメントを残したまま、Miyou分だけ再取得する。 */
	public async refreshMiyou(
		duration: number,
	): Promise<NiconicoComment[] | null> {
		if (
			this.sources.length === 0 ||
			duration <= 0 ||
			!getSettings().miyouEnabled
		) {
			return this.getSynchronizedComments();
		}
		if (this.isFetching) {
			this.pendingMiyouRefresh = true;
			return this.getSynchronizedComments();
		}

		const revision = this.fetchRevision;
		const offsets = getChunkOffsets(duration);
		const seenIds = new Set(this.allComments.map((comment) => comment.id));
		this.lastFetchDuration = duration;
		this.pendingMiyouRefresh = false;
		this.isFetching = true;
		try {
			for (const state of this.sourceStates) {
				const applicableOffsets = offsets.filter(
					(offset) => offset < state.source.endAt - state.source.startAt,
				);
				state.applicableOffsets = applicableOffsets;
				let hasMiyouFailure = false;
				for (const offset of applicableOffsets) {
					if (revision !== this.fetchRevision) return null;
					const windowDuration = Math.min(
						KAKOLOG_CHUNK_SIZE,
						Math.max(duration - offset, 0),
					);
					if (windowDuration <= 0) continue;

					const fetched = await this.fetchMiyouSourceChunk({
						source: state.source,
						sourceStart: Math.floor(state.source.startAt + offset),
						sourceEnd: Math.floor(
							Math.min(
								state.source.startAt + offset + windowDuration,
								state.source.endAt,
								Math.floor(Date.now() / 60_000) * 60,
							),
						),
						sourceOrdinal: state.sourceOrdinal,
					});
					if (revision !== this.fetchRevision) return null;
					let addedCount = 0;
					for (const comment of fetched.comments) {
						if (seenIds.has(comment.id)) continue;
						seenIds.add(comment.id);
						this.allComments.push(comment);
						addedCount += 1;
					}
					state.commentCount += addedCount;
					this.totalFetched += addedCount;

					if (fetched.success) {
						state.miyouFetchedOffsets.add(offset);
					} else {
						// Miyou の失敗区間だけを次回の通常取得で再試行できるようにする。
						state.miyouFetchedOffsets.delete(offset);
						state.fetchedOffsets.delete(offset);
						hasMiyouFailure = true;
					}
					if (
						state.niconicoFetchedOffsets.has(offset) &&
						state.miyouFetchedOffsets.has(offset)
					) {
						state.fetchedOffsets.add(offset);
					} else {
						state.fetchedOffsets.delete(offset);
					}
				}

				state.completed =
					state.fetchedOffsets.size >= state.applicableOffsets.length;
				if (state.completed) {
					state.interrupted = false;
				} else if (hasMiyouFailure) {
					state.interrupted = true;
				}
			}
			if (revision === this.fetchRevision) {
				this.interruptOffset = this.computeInterruptOffset();
			}
		} finally {
			if (revision === this.fetchRevision) {
				this.isFetching = false;
			}
		}

		if (revision !== this.fetchRevision) return null;
		if (this.pendingMiyouRefresh) {
			this.pendingMiyouRefresh = false;
			if (getSettings().miyouEnabled) {
				return this.refreshMiyou(duration);
			}
		}

		return this.getSynchronizedComments();
	}

	private async flushPendingMiyouRefresh(duration: number) {
		if (!this.pendingMiyouRefresh) return;
		this.pendingMiyouRefresh = false;
		if (!getSettings().miyouEnabled) return;
		await this.refreshMiyou(duration);
	}

	private getSynchronizedComments(): NiconicoComment[] {
		const comments = getSettings().miyouEnabled
			? this.allComments
			: this.allComments.filter((comment) => comment.origin !== "miyou");
		const settings = getSettings();
		const disabledSourceOrdinals = new Set<number>();
		for (const [sourceOrdinal, source] of this.sources.entries()) {
			if (this.disabledChapterCorrectionSourceKeys.has(source.key)) {
				disabledSourceOrdinals.add(sourceOrdinal);
			}
		}
		const synchronized = synchronizeCommentSourcesByChapters(
			comments,
			this.sources,
			{
				windowSeconds: settings.chapterWindowSeconds,
				cooldownSeconds: settings.chapterCooldownSeconds,
				minimumCount: settings.chapterMinimumCount,
				disabledSourceOrdinals,
			},
		);
		this.chapterCorrections = synchronized.corrections;
		const correctionSignature = JSON.stringify(synchronized.corrections);
		if (correctionSignature !== this.correctionSignature) {
			this.correctionSignature = correctionSignature;
			for (const correction of synchronized.corrections) {
				const source = this.sources[correction.sourceOrdinal];
				console.info(
					`[Kakolog] Chapter-synced ${source?.jkId || correction.sourceOrdinal} by ${correction.offsetSeconds.toFixed(2)}s (${correction.matchedLabels.join(", ")})`,
				);
			}
		}
		return sortAndDedupeComments(synchronized.comments);
	}

	public getChapterCorrections(): ChapterCorrectionInfo[] {
		return this.chapterCorrections.flatMap((correction) => {
			const source = this.sources[correction.sourceOrdinal];
			if (!source) {
				return [];
			}
			return [
				{
					sourceKey: source.key,
					offsetSeconds: correction.offsetSeconds,
					matchedLabels: correction.matchedLabels,
					enabled: !this.disabledChapterCorrectionSourceKeys.has(source.key),
				},
			];
		});
	}

	public setChapterCorrectionEnabled(
		sourceKey: string,
		enabled: boolean,
	): NiconicoComment[] {
		if (enabled) {
			this.disabledChapterCorrectionSourceKeys.delete(sourceKey);
		} else {
			this.disabledChapterCorrectionSourceKeys.add(sourceKey);
		}
		return this.getSynchronizedComments();
	}

	public getInterruptedSourceKeys(): Set<string> {
		const keys = new Set<string>();
		for (const state of this.sourceStates) {
			if (state.interrupted && !state.completed) {
				keys.add(state.sourceKey);
			}
		}
		return keys;
	}

	public getInterruptedSources(): InterruptedSourceInfo[] {
		const result: InterruptedSourceInfo[] = [];
		for (const state of this.sourceStates) {
			if (state.interrupted && !state.completed) {
				const fetchedOffsets = [...state.fetchedOffsets].sort((a, b) => a - b);
				const firstOffset = fetchedOffsets[0];
				const lastOffset = fetchedOffsets[fetchedOffsets.length - 1];
				const fetchedStartAt =
					fetchedOffsets.length > 0 ? state.source.startAt + firstOffset : null;
				const fetchedEndAt =
					fetchedOffsets.length > 0
						? Math.min(
								state.source.startAt + lastOffset + KAKOLOG_CHUNK_SIZE,
								state.source.endAt,
							)
						: null;
				const chunks: InterruptedChunkState[] = state.applicableOffsets.map(
					(offset) => ({
						startAt: state.source.startAt + offset,
						endAt: Math.min(
							state.source.startAt + offset + KAKOLOG_CHUNK_SIZE,
							state.source.endAt,
						),
						fetched: state.fetchedOffsets.has(offset),
					}),
				);
				result.push({
					sourceKey: state.sourceKey,
					jkId: state.source.jkId,
					channelName: state.source.channelName,
					kind: state.source.kind,
					commentCount: state.commentCount,
					fetchedChunkCount: fetchedOffsets.length,
					totalChunkCount: state.applicableOffsets.length,
					fetchedStartAt,
					fetchedEndAt,
					chunks,
				});
			}
		}
		return result;
	}

	public getInterruptPosition(): number | null {
		return this.interruptOffset;
	}

	/** 指定再生位置が未取得チャンク内にあるか（シーク直後の即時取得判定用、primary 基準） */
	public isUnfetchedAt(playerTime: number): boolean {
		const primary = this.sourceStates[0];
		if (!primary || primary.completed) return false;
		for (const offset of primary.applicableOffsets) {
			if (primary.fetchedOffsets.has(offset)) continue;
			if (playerTime >= offset && playerTime < offset + KAKOLOG_CHUNK_SIZE) {
				return true;
			}
		}
		return false;
	}

	/** シーク位置基準で「次の未取得チャンク」が1分以内に迫ったら true */
	public shouldAutoResume(playerTime: number): boolean {
		if (this.isFetching) return false;
		const hasInterrupted = this.sourceStates.some(
			(s) => s.interrupted && !s.completed,
		);
		if (!hasInterrupted) return false;

		let nextUnfetched: number | null = null;
		for (const state of this.sourceStates) {
			if (state.completed) continue;
			for (const offset of state.applicableOffsets) {
				if (state.fetchedOffsets.has(offset)) continue;
				if (offset < playerTime) continue;
				if (nextUnfetched == null || offset < nextUnfetched) {
					nextUnfetched = offset;
				}
			}
		}
		if (nextUnfetched == null) return false;
		return nextUnfetched <= playerTime + AUTO_RESUME_LEAD_SECONDS;
	}

	public isFullyCompleted(): boolean {
		return (
			this.sourceStates.length > 0 &&
			this.sourceStates.every((s) => s.completed)
		);
	}

	/** 解決後に追加されたソースで、まだ一度も取得できていないものがあるか */
	public hasPendingInitialSourceFetch(): boolean {
		return this.sourceStates.some((state) => state.needsInitialFetch);
	}

	public async fetchWithLimit(
		duration: number,
		options?: {
			priorityTime?: number;
			onPartialComments?: (comments: NiconicoComment[]) => void;
		},
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0 || duration <= 0) {
			this.resetProgress();
			return [];
		}

		if (this.isFullyCompleted()) {
			this.resetProgress();
			return this.getSynchronizedComments();
		}

		if (this.isFetching) {
			return this.getSynchronizedComments();
		}

		const revision = this.fetchRevision;
		this.batchStartCount = 0;
		this.batchLimit = MAX_FETCH_COMMENTS;

		await this.runFetchLoop(duration, {
			priorityTime: options?.priorityTime,
			onPartialComments: options?.onPartialComments,
		});
		if (revision === this.fetchRevision) {
			await this.flushPendingMiyouRefresh(duration);
		}

		if (revision !== this.fetchRevision) return [];
		return this.getSynchronizedComments();
	}

	public async fetchMore(
		duration: number,
		options?: {
			priorityTime?: number;
			onPartialComments?: (comments: NiconicoComment[]) => void;
		},
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0 || duration <= 0) return [];
		if (this.isFetching) return this.getSynchronizedComments();
		if (this.isFullyCompleted()) return this.getSynchronizedComments();

		const revision = this.fetchRevision;
		this.batchStartCount = this.totalFetched;
		this.batchLimit = MAX_FETCH_COMMENTS;

		await this.runFetchLoop(duration, {
			priorityTime: options?.priorityTime,
			forwardOnly: options?.priorityTime != null,
			onPartialComments: options?.onPartialComments,
		});
		if (revision === this.fetchRevision) {
			await this.flushPendingMiyouRefresh(duration);
		}

		if (revision !== this.fetchRevision) return [];
		return this.getSynchronizedComments();
	}

	public async resumeSource(
		sourceKey: string,
		duration: number,
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0 || duration <= 0) return [];
		if (this.isFetching) return this.getSynchronizedComments();

		const state = this.sourceStates.find((s) => s.sourceKey === sourceKey);
		if (!state || state.completed) return this.getSynchronizedComments();

		const revision = this.fetchRevision;
		state.ignoreLimit = true;
		state.interrupted = false;

		await this.runFetchLoop(duration, {
			singleSourceKey: sourceKey,
		});
		if (revision === this.fetchRevision) {
			await this.flushPendingMiyouRefresh(duration);
		}

		if (revision !== this.fetchRevision) return [];
		return this.getSynchronizedComments();
	}

	private async runFetchLoop(
		duration: number,
		options: {
			priorityTime?: number;
			forwardOnly?: boolean;
			singleSourceKey?: string | null;
			onPartialComments?: (comments: NiconicoComment[]) => void;
		},
	): Promise<void> {
		const revision = this.fetchRevision;
		this.isFetching = true;
		this.lastFetchDuration = duration;

		const priorityOffset = getPriorityChunkStart(
			options?.priorityTime || 0,
			duration,
		);

		const allOffsets = getChunkOffsets(duration);
		for (const state of this.sourceStates) {
			state.applicableOffsets = allOffsets.filter(
				(offset) => offset < state.source.endAt - state.source.startAt,
			);
		}

		const statesToProcess = options?.singleSourceKey
			? this.sourceStates.filter((s) => s.sourceKey === options.singleSourceKey)
			: this.sourceStates;

		this.progressState = {
			totalRequests: this.countRemainingRequests(statesToProcess),
			completedRequests: 0,
			skippedRequests: 0,
			fetchedComments: this.totalFetched,
			currentSourceJkId: null,
			currentSourceChannelName: null,
		};
		this.emitProgress();

		for (const state of statesToProcess) {
			if (revision !== this.fetchRevision) break;
			if (state.completed) continue;

			const orderedOffsets = this.getOrderedOffsets(
				state,
				priorityOffset,
				options.forwardOnly,
			);

			for (const offset of orderedOffsets) {
				if (revision !== this.fetchRevision) break;
				if (state.fetchedOffsets.has(offset)) continue;
				const fetchNiconico = !state.niconicoFetchedOffsets.has(offset);
				const fetchMiyou =
					this.shouldFetchMiyou(state.source) &&
					!state.miyouFetchedOffsets.has(offset);

				if (
					!state.ignoreLimit &&
					this.totalFetched - this.batchStartCount >= this.batchLimit
				) {
					this.finalizeFetchState(revision);
					return;
				}

				const windowDuration = Math.min(
					KAKOLOG_CHUNK_SIZE,
					Math.max(duration - offset, 0),
				);
				if (windowDuration <= 0) {
					state.niconicoFetchedOffsets.add(offset);
					state.miyouFetchedOffsets.add(offset);
					state.fetchedOffsets.add(offset);
					continue;
				}

				if (this.progressState) {
					this.progressState.currentSourceJkId = state.source.jkId;
					this.progressState.currentSourceChannelName =
						state.source.channelName;
					this.emitProgress();
				}

				try {
					const fetched = await this.fetchSourceChunk({
						source: state.source,
						offset,
						windowDuration,
						sourceOrdinal: state.sourceOrdinal,
						fetchNiconico,
						fetchMiyou,
					});

					if (revision !== this.fetchRevision) break;

					if (fetched.niconicoFetched) {
						state.niconicoFetchedOffsets.add(offset);
					}
					if (fetched.miyouFetched) {
						state.miyouFetchedOffsets.add(offset);
					}
					if (
						state.niconicoFetchedOffsets.has(offset) &&
						(!fetchMiyou || state.miyouFetchedOffsets.has(offset))
					) {
						state.fetchedOffsets.add(offset);
					} else {
						state.fetchedOffsets.delete(offset);
					}

					const existingIds = new Set(
						this.allComments.map((comment) => comment.id),
					);
					const newComments = fetched.comments.filter((comment) => {
						if (existingIds.has(comment.id)) return false;
						existingIds.add(comment.id);
						return true;
					});
					if (
						(fetchNiconico && fetched.niconicoFetched) ||
						(fetchMiyou && fetched.miyouFetched)
					) {
						state.needsInitialFetch = false;
					}
					state.commentCount += newComments.length;
					this.allComments.push(...newComments);
					this.totalFetched += newComments.length;

					if (this.progressState) {
						if (state.fetchedOffsets.has(offset)) {
							this.progressState.completedRequests += 1;
						}
						this.progressState.fetchedComments = this.totalFetched;
						this.emitProgress();
					}

					if (
						!options.singleSourceKey &&
						options.onPartialComments &&
						(newComments.length > 0 ||
							fetched.niconicoFetched ||
							fetched.miyouFetched)
					) {
						options.onPartialComments(this.getSynchronizedComments());
					}
				} catch (error) {
					console.error(
						`[Kakolog] Fetch failed for ${state.source.jkId} at offset ${offset}`,
						error,
					);
					// エラー時は fetchedOffsets に追加せず、次回再試行可能にする
				}
			}

			if (revision !== this.fetchRevision) break;

			if (state.fetchedOffsets.size >= state.applicableOffsets.length) {
				state.completed = true;
				state.interrupted = false;
			}

			if (
				!state.ignoreLimit &&
				this.totalFetched - this.batchStartCount >= this.batchLimit
			) {
				this.finalizeFetchState(revision);
				return;
			}
		}

		this.finalizeFetchState(revision);
	}

	private finalizeFetchState(revision: number): void {
		if (revision !== this.fetchRevision) return;
		this.interruptOffset = this.computeInterruptOffset();
		const hasUnfetched = this.interruptOffset != null;
		for (const state of this.sourceStates) {
			if (state.completed) {
				state.interrupted = false;
			} else {
				state.interrupted = hasUnfetched;
			}
		}
		this.resetProgress();
		this.isFetching = false;
	}

	private getOrderedOffsets(
		state: SourceFetchState,
		priorityOffset: number,
		forwardOnly?: boolean,
	): number[] {
		const applicable = state.applicableOffsets;
		if (applicable.length === 0) return [];

		const base = forwardOnly
			? applicable.filter((o) => o >= priorityOffset)
			: applicable;

		if (base.includes(priorityOffset)) {
			return [priorityOffset, ...base.filter((o) => o !== priorityOffset)];
		}

		return base;
	}

	private computeInterruptOffset(): number | null {
		for (const state of this.sourceStates) {
			if (state.completed) continue;
			for (const offset of state.applicableOffsets) {
				if (!state.fetchedOffsets.has(offset)) {
					return offset;
				}
			}
		}
		return null;
	}

	private countRemainingRequests(states: SourceFetchState[]): number {
		let total = 0;
		for (const state of states) {
			if (state.completed) continue;
			for (const offset of state.applicableOffsets) {
				if (!state.fetchedOffsets.has(offset)) {
					total += 1;
				}
			}
		}
		return total;
	}

	private emitProgress() {
		if (!this.progressListener) {
			return;
		}
		if (!this.progressState) {
			this.progressListener(null);
			return;
		}

		const totalRequests = Math.max(
			this.progressState.completedRequests,
			this.progressState.totalRequests - this.progressState.skippedRequests,
		);
		const currentRequest = this.progressState.currentSourceJkId
			? Math.min(this.progressState.completedRequests + 1, totalRequests)
			: this.progressState.completedRequests;
		const remainingRequests = Math.max(totalRequests - currentRequest, 0);

		this.progressListener({
			currentSourceJkId: this.progressState.currentSourceJkId,
			currentSourceChannelName: this.progressState.currentSourceChannelName,
			currentRequest,
			totalRequests,
			remainingRequests,
			fetchedComments: this.progressState.fetchedComments,
		});
	}

	private resetProgress() {
		this.progressState = null;
		this.emitProgress();
	}

	private shouldFetchMiyou(source: ResolvedCommentSource): boolean {
		return Boolean(source.miyouChannel && getSettings().miyouEnabled);
	}

	private async fetchSourceChunk(params: {
		source: ResolvedCommentSource;
		offset: number;
		windowDuration: number;
		sourceOrdinal: number;
		fetchNiconico: boolean;
		fetchMiyou: boolean;
	}): Promise<SourceChunkFetchResult> {
		const {
			source,
			offset,
			windowDuration,
			sourceOrdinal,
			fetchNiconico,
			fetchMiyou,
		} = params;
		const sourceStart = Math.floor(source.startAt + offset);
		// 過去ログ API の終端は現在時刻の分開始（秒=0）を超えないようにする。
		const currentMinuteStart = Math.floor(Date.now() / 60_000) * 60;
		const sourceEnd = Math.floor(
			Math.min(sourceStart + windowDuration, source.endAt, currentMinuteStart),
		);
		if (sourceStart >= sourceEnd) {
			return {
				comments: [],
				niconicoFetched: true,
				miyouFetched: true,
			};
		}

		if (fetchNiconico || fetchMiyou) {
			console.log(
				`[Kakolog] Fetching ${source.jkId}: offset=${offset} (${new Date(sourceStart * 1000).toLocaleString()})`,
			);
		}

		let niconicoComments: NiconicoComment[] = [];
		let niconicoFetched = !fetchNiconico;
		if (fetchNiconico) {
			const url = new URL(
				`https://jikkyo.tsukumijima.net/api/kakolog/${source.jkId}`,
			);
			url.searchParams.set("format", "json");
			url.searchParams.set("starttime", String(sourceStart));
			url.searchParams.set("endtime", String(sourceEnd));

			try {
				const data = await fetchJson<KakologResponse | { error: string }>(url);
				if ("error" in data) {
					console.error("[Kakolog] API Error", data.error);
				} else {
					niconicoComments = data.packet.flatMap((p) => {
						const c = p.chat;
						if (!c) return [];

						const date = parseInt(c.date, 10);
						const date_usec = parseInt(c.date_usec || "0", 10);
						const no = parseInt(c.no, 10);
						const primarySource = this.sources[0];
						let vpos: number;
						if (primarySource && sourceOrdinal > 0) {
							const relativeTime =
								date +
								date_usec / 1_000_000 -
								(source.programStartAt ?? source.startAt);
							const masterBaseTime =
								primarySource.programStartAt ?? primarySource.startAt;
							vpos = Math.floor((masterBaseTime + relativeTime) * 100);
						} else {
							vpos = Math.floor((date + date_usec / 1_000_000) * 100);
						}

						return [
							{
								id: buildStableCommentId({
									seconds: date,
									microseconds: date_usec,
									no,
									sourceOrdinal,
								}),
								no,
								vpos,
								content: c.content,
								date,
								date_usec,
								mail: c.mail?.split(" ") || [],
								user_id: c.user_id,
								premium: parseInt(c.premium || "0", 10),
								anonymity: parseInt(c.anonymity || "0", 10),
								origin: "ws" as const,
								sourceOrdinal,
							},
						];
					});
				}
				niconicoFetched = true;
			} catch (error) {
				console.error(
					`[Kakolog] NicoNico fetch failed for ${source.jkId}`,
					error,
				);
			}
		}

		let miyouComments: NiconicoComment[] = [];
		let miyouFetched = !fetchMiyou;
		if (fetchMiyou) {
			const fetched = await this.fetchMiyouSourceChunk({
				source,
				sourceStart,
				sourceEnd,
				sourceOrdinal,
			});
			miyouComments = fetched.comments;
			miyouFetched = fetched.success;
		}

		return {
			comments: [...niconicoComments, ...miyouComments],
			niconicoFetched,
			miyouFetched,
		};
	}

	private async fetchMiyouSourceChunk(params: {
		source: ResolvedCommentSource;
		sourceStart: number;
		sourceEnd: number;
		sourceOrdinal: number;
	}): Promise<{ comments: NiconicoComment[]; success: boolean }> {
		const { source, sourceStart, sourceEnd, sourceOrdinal } = params;
		if (!source.miyouChannel || !getSettings().miyouEnabled) {
			return { comments: [], success: true };
		}

		const comments: NiconicoComment[] = [];
		let success = true;
		// Miyou の既存クライアントと同じく、5ch API は 10 分単位で取得する。
		for (let start = sourceStart; start < sourceEnd; start += 600) {
			const end = Math.min(start + 600, sourceEnd);
			try {
				const fetched = await fetchMiyouComments({
					channel: source.miyouChannel,
					start,
					end,
				});
				comments.push(
					...fetched.map((comment) =>
						convertMiyouComment(
							comment,
							source,
							sourceOrdinal,
							this.sources[0] || source,
						),
					),
				);
			} catch (error) {
				success = false;
				// 5ch は追加ソースなので、認証切れや API 障害でニコニコ取得を失敗させない。
				console.error(
					`[Kakolog] Miyou fetch failed for ${source.miyouChannel} (${start}-${end})`,
					error,
				);
			}
		}

		return { comments, success };
	}
}
