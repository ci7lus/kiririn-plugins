import type { NiconicoComment } from "./comment-client";
import { buildStableCommentId } from "./comment-id";
import { fetchJson } from "./host-fetch";
import type { ResolvedCommentSource } from "./source-resolver";

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
	private fullFetchDuration = 0;
	private fullFetchPromise: Promise<NiconicoComment[]> | null = null;
	private fullFetchResult: NiconicoComment[] | null = null;
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
	private chunkStates = new Map<
		number,
		{
			commentCount: number;
			completed: boolean;
			fetchedSourceKeys: Set<string>;
		}
	>();

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
		this.fullFetchDuration = 0;
		this.fullFetchPromise = null;
		this.fullFetchResult = null;
		this.resetProgress();
		this.chunkStates.clear();
	}

	public clearCache() {
		this.fetchRevision += 1;
		this.fullFetchDuration = 0;
		this.fullFetchPromise = null;
		this.fullFetchResult = null;
		this.resetProgress();
		this.chunkStates.clear();
	}

	public setProgressListener(
		listener: ((progress: KakologFetchProgress | null) => void) | null,
	) {
		this.progressListener = listener;
		this.emitProgress();
	}

	public async fetchIfNeeded(
		playerTime: number,
		duration: number,
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0) return [];

		const currentChunkStart = getPriorityChunkStart(playerTime, duration);

		const tasks: Promise<NiconicoComment[]>[] = [];
		if (currentChunkStart < duration) {
			tasks.push(this.fetchChunkGroup(currentChunkStart, duration));
		}
		if (currentChunkStart + KAKOLOG_CHUNK_SIZE < duration) {
			tasks.push(
				this.fetchChunkGroup(currentChunkStart + KAKOLOG_CHUNK_SIZE, duration),
			);
		}

		const results = await Promise.all(tasks);
		return results.flat().sort((a, b) => a.vpos - b.vpos);
	}

	public async fetchAll(
		duration: number,
		options?: {
			priorityTime?: number;
			onPriorityChunkFetched?: (comments: NiconicoComment[]) => void;
		},
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0 || duration <= 0) {
			this.resetProgress();
			return [];
		}

		if (this.fullFetchResult && this.fullFetchDuration === duration) {
			this.resetProgress();
			return this.fullFetchResult;
		}

		if (this.fullFetchPromise && this.fullFetchDuration === duration) {
			return this.fullFetchPromise;
		}

		const revision = this.fetchRevision;
		this.fullFetchDuration = duration;
		this.progressState = {
			totalRequests: this.countPotentialRequests(duration),
			completedRequests: 0,
			skippedRequests: 0,
			fetchedComments: 0,
			currentSourceJkId: null,
			currentSourceChannelName: null,
		};
		this.emitProgress();

		let promise: Promise<NiconicoComment[]>;
		promise = (async () => {
			const comments: NiconicoComment[] = [];
			const offsets = getChunkOffsets(duration);
			const priorityOffset = getPriorityChunkStart(
				options?.priorityTime || 0,
				duration,
			);
			const orderedOffsets = [
				priorityOffset,
				...offsets.filter((offset) => offset !== priorityOffset),
			];
			const shouldEmitPriorityChunk =
				typeof options?.onPriorityChunkFetched === "function" &&
				orderedOffsets.length > 1;
			let emittedPriorityChunk = false;

			for (const offset of orderedOffsets) {
				if (revision !== this.fetchRevision) {
					return [];
				}

				const fetched = await this.fetchChunkGroup(offset, duration);
				if (revision !== this.fetchRevision) {
					return [];
				}

				comments.push(...fetched);
				if (!emittedPriorityChunk && offset === priorityOffset) {
					emittedPriorityChunk = true;
					if (shouldEmitPriorityChunk) {
						options.onPriorityChunkFetched?.(sortAndDedupeComments(comments));
					}
				}
			}

			const result = sortAndDedupeComments(comments);
			if (revision === this.fetchRevision) {
				this.fullFetchResult = result;
			}

			return result;
		})().finally(() => {
			this.resetProgress();
			if (this.fullFetchPromise === promise) {
				this.fullFetchPromise = null;
			}
		});

		this.fullFetchPromise = promise;
		return promise;
	}

	private async fetchChunkGroup(
		offset: number,
		duration: number,
	): Promise<NiconicoComment[]> {
		let state = this.chunkStates.get(offset);
		if (!state) {
			state = {
				commentCount: 0,
				completed: false,
				fetchedSourceKeys: new Set(),
			};
			this.chunkStates.set(offset, state);
		}
		if (state.completed) {
			return [];
		}

		const windowDuration = Math.min(
			KAKOLOG_CHUNK_SIZE,
			Math.max(duration - offset, 0),
		);
		if (windowDuration <= 0) {
			state.completed = true;
			return [];
		}

		const applicableSources = this.sources.filter(
			(source) => offset < source.endAt - source.startAt,
		);
		if (applicableSources.length === 0) {
			state.completed = true;
			return [];
		}

		const newComments: NiconicoComment[] = [];
		for (const source of applicableSources) {
			if (state.fetchedSourceKeys.has(source.key)) {
				continue;
			}

			const sourceOrdinal = this.sources.findIndex(
				(candidate) => candidate.key === source.key,
			);
			if (this.progressState) {
				this.progressState.currentSourceJkId = source.jkId;
				this.progressState.currentSourceChannelName = source.channelName;
				this.emitProgress();
			}
			state.fetchedSourceKeys.add(source.key);
			const fetched = await this.fetchSourceChunk({
				source,
				offset,
				windowDuration,
				sourceOrdinal: sourceOrdinal < 0 ? 0 : sourceOrdinal,
			});
			if (this.progressState) {
				this.progressState.completedRequests += 1;
				this.progressState.fetchedComments += fetched.length;
			}
			state.commentCount += fetched.length;
			newComments.push(...fetched);

			if (
				this.isDenseEnough(state.commentCount, windowDuration) ||
				state.fetchedSourceKeys.size >= applicableSources.length
			) {
				if (
					this.progressState &&
					state.fetchedSourceKeys.size < applicableSources.length
				) {
					this.progressState.skippedRequests +=
						applicableSources.length - state.fetchedSourceKeys.size;
				}
				state.completed = true;
				if (this.progressState) {
					this.progressState.currentSourceJkId = null;
					this.progressState.currentSourceChannelName = null;
					this.emitProgress();
				}
				break;
			}

			if (this.progressState) {
				this.progressState.currentSourceJkId = null;
				this.progressState.currentSourceChannelName = null;
				this.emitProgress();
			}
		}

		if (state.fetchedSourceKeys.size >= applicableSources.length) {
			state.completed = true;
		}

		return newComments;
	}

	// コメントが十分集まっている場合、同じ範囲の残りのソースは取得しない（リクエストをスキップする）
	private isDenseEnough(commentCount: number, windowDuration: number) {
		const minutes = Math.max(windowDuration / 60, 1);
		return commentCount / minutes >= 1000; // 1分あたり1000コメント以上なら十分とみなす
	}

	private countPotentialRequests(duration: number) {
		let total = 0;
		for (const offset of getChunkOffsets(duration)) {
			total += this.sources.filter(
				(source) => offset < source.endAt - source.startAt,
			).length;
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

		try {
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
				// vpos は絶対 unixtime × 100。
				// primary: vpos = date * 100（そのまま）。
				// secondary source: 同エピソードの同一タイミングのコメントが primary と同じ vpos になるよう、
				//   source の programStartAt を基点とした相対秒を primary の programStartAt にマッピングする。
				//   vpos = (T_prog_primary + (date - T_prog_replay)) * 100
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
		} catch (e) {
			console.error(`[Kakolog] Fetch failed for ${source.jkId}`, e);
			const state = this.chunkStates.get(offset);
			state?.fetchedSourceKeys.delete(source.key);
			return [];
		}
	}
}
