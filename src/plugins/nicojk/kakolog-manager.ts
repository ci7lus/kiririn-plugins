import type { NiconicoComment } from "./comment-client";
import { buildStableCommentId } from "./comment-id";
import { fetchJson } from "./host-fetch";
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

interface SourceFetchState {
	sourceKey: string;
	sourceOrdinal: number;
	source: ResolvedCommentSource;
	applicableOffsets: number[];
	fetchedOffsets: Set<number>;
	completed: boolean;
	interrupted: boolean;
	ignoreLimit: boolean;
	commentCount: number;
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

	public setSources(sources: ResolvedCommentSource[]) {
		const signature = JSON.stringify(
			sources.map((source) => [
				source.key,
				source.jkId,
				source.startAt,
				source.endAt,
			]),
		);
		if (this.sourceSignature === signature) {
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
			completed: false,
			interrupted: false,
			ignoreLimit: false,
			commentCount: 0,
		}));
		this.totalFetched = 0;
		this.batchStartCount = 0;
		this.batchLimit = MAX_FETCH_COMMENTS;
		this.isFetching = false;
		this.interruptOffset = null;
		this.resetProgress();
	}

	public clearCache() {
		this.fetchRevision += 1;
		this.allComments = [];
		for (const state of this.sourceStates) {
			state.fetchedOffsets.clear();
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
		this.interruptOffset = null;
		this.resetProgress();
	}

	public setProgressListener(
		listener: ((progress: KakologFetchProgress | null) => void) | null,
	) {
		this.progressListener = listener;
		this.emitProgress();
	}

	public getAllComments(): NiconicoComment[] {
		return sortAndDedupeComments(this.allComments);
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
			return sortAndDedupeComments(this.allComments);
		}

		if (this.isFetching) {
			return sortAndDedupeComments(this.allComments);
		}

		const revision = this.fetchRevision;
		this.batchStartCount = 0;
		this.batchLimit = MAX_FETCH_COMMENTS;

		await this.runFetchLoop(duration, {
			priorityTime: options?.priorityTime,
			onPartialComments: options?.onPartialComments,
		});

		if (revision !== this.fetchRevision) return [];
		return sortAndDedupeComments(this.allComments);
	}

	public async fetchMore(
		duration: number,
		options?: { priorityTime?: number },
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0 || duration <= 0) return [];
		if (this.isFetching) return sortAndDedupeComments(this.allComments);
		if (this.isFullyCompleted()) return sortAndDedupeComments(this.allComments);

		const revision = this.fetchRevision;
		this.batchStartCount = this.totalFetched;
		this.batchLimit = MAX_FETCH_COMMENTS;

		await this.runFetchLoop(duration, {
			priorityTime: options?.priorityTime,
			forwardOnly: options?.priorityTime != null,
		});

		if (revision !== this.fetchRevision) return [];
		return sortAndDedupeComments(this.allComments);
	}

	public async resumeSource(
		sourceKey: string,
		duration: number,
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0 || duration <= 0) return [];
		if (this.isFetching) return sortAndDedupeComments(this.allComments);

		const state = this.sourceStates.find((s) => s.sourceKey === sourceKey);
		if (!state || state.completed)
			return sortAndDedupeComments(this.allComments);

		const revision = this.fetchRevision;
		state.ignoreLimit = true;
		state.interrupted = false;

		await this.runFetchLoop(duration, {
			singleSourceKey: sourceKey,
		});

		if (revision !== this.fetchRevision) return [];
		return sortAndDedupeComments(this.allComments);
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

		let partialEmitted = false;

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

				if (
					!state.ignoreLimit &&
					this.totalFetched - this.batchStartCount >= this.batchLimit
				) {
					this.finalizeFetchState();
					return;
				}

				const windowDuration = Math.min(
					KAKOLOG_CHUNK_SIZE,
					Math.max(duration - offset, 0),
				);
				if (windowDuration <= 0) {
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
					});

					if (revision !== this.fetchRevision) break;

					state.fetchedOffsets.add(offset);
					state.commentCount += fetched.length;
					this.allComments.push(...fetched);
					this.totalFetched += fetched.length;

					if (this.progressState) {
						this.progressState.completedRequests += 1;
						this.progressState.fetchedComments = this.totalFetched;
						this.emitProgress();
					}

					if (
						!partialEmitted &&
						!options.singleSourceKey &&
						options.onPartialComments
					) {
						partialEmitted = true;
						options.onPartialComments(sortAndDedupeComments(this.allComments));
					}
				} catch (e) {
					console.error(
						`[Kakolog] Fetch failed for ${state.source.jkId} at offset ${offset}`,
						e,
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
				this.finalizeFetchState();
				return;
			}
		}

		this.finalizeFetchState();
	}

	private finalizeFetchState(): void {
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

	private async fetchSourceChunk(params: {
		source: ResolvedCommentSource;
		offset: number;
		windowDuration: number;
		sourceOrdinal: number;
	}): Promise<NiconicoComment[]> {
		const { source, offset, windowDuration, sourceOrdinal } = params;
		const sourceStart = source.startAt + offset;
		const sourceEnd = Math.min(sourceStart + windowDuration, source.endAt);
		if (sourceStart >= sourceEnd) {
			return [];
		}

		console.log(
			`[Kakolog] Fetching ${source.jkId}: offset=${offset} (${new Date(sourceStart * 1000).toLocaleString()})`,
		);
		const url = new URL(
			`https://jikkyo.tsukumijima.net/api/kakolog/${source.jkId}`,
		);
		url.searchParams.set("format", "json");
		url.searchParams.set("starttime", String(sourceStart));
		url.searchParams.set("endtime", String(sourceEnd));

		const data = await fetchJson<KakologResponse | { error: string }>(url);
		if ("error" in data) {
			console.error("[Kakolog] API Error", data.error);
			return [];
		}

		const newComments: NiconicoComment[] = data.packet.flatMap((p) => {
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
					origin: "ws",
					sourceOrdinal,
				},
			];
		});

		return newComments;
	}
}
