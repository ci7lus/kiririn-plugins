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

export class KakologManager {
	private baseStartAt = 0;
	private sourceSignature = "";
	private sources: ResolvedCommentSource[] = [];
	private fetchRevision = 0;
	private fullFetchDuration = 0;
	private fullFetchPromise: Promise<NiconicoComment[]> | null = null;
	private fullFetchResult: NiconicoComment[] | null = null;
	private chunkStates = new Map<
		number,
		{
			commentCount: number;
			completed: boolean;
			fetchedSourceKeys: Set<string>;
		}
	>();

	public setSources(baseStartAt: number, sources: ResolvedCommentSource[]) {
		const signature = JSON.stringify({
			baseStartAt,
			sources: sources.map((source) => [
				source.key,
				source.jkId,
				source.startAt,
				source.endAt,
			]),
		});
		if (this.sourceSignature === signature) {
			return;
		}

		this.baseStartAt = baseStartAt;
		this.sourceSignature = signature;
		this.sources = sources;
		this.fetchRevision += 1;
		this.fullFetchDuration = 0;
		this.fullFetchPromise = null;
		this.fullFetchResult = null;
		this.chunkStates.clear();
	}

	public clearCache() {
		this.fetchRevision += 1;
		this.fullFetchDuration = 0;
		this.fullFetchPromise = null;
		this.fullFetchResult = null;
		this.chunkStates.clear();
	}

	public async fetchIfNeeded(
		playerTime: number,
		duration: number,
	): Promise<NiconicoComment[]> {
		if (this.sources.length === 0) return [];

		const chunkSize = 600;
		const currentChunkStart = Math.floor(playerTime / chunkSize) * chunkSize;

		const tasks: Promise<NiconicoComment[]>[] = [];
		if (currentChunkStart < duration) {
			tasks.push(this.fetchChunkGroup(currentChunkStart, duration));
		}
		if (currentChunkStart + chunkSize < duration) {
			tasks.push(this.fetchChunkGroup(currentChunkStart + chunkSize, duration));
		}

		const results = await Promise.all(tasks);
		return results.flat().sort((a, b) => a.vpos - b.vpos);
	}

	public async fetchAll(duration: number): Promise<NiconicoComment[]> {
		if (this.sources.length === 0 || duration <= 0) {
			return [];
		}

		if (this.fullFetchResult && this.fullFetchDuration === duration) {
			return this.fullFetchResult;
		}

		if (this.fullFetchPromise && this.fullFetchDuration === duration) {
			return this.fullFetchPromise;
		}

		const revision = this.fetchRevision;
		this.fullFetchDuration = duration;

		let promise: Promise<NiconicoComment[]>;
		promise = (async () => {
			const chunkSize = 600;
			const comments: NiconicoComment[] = [];

			for (let offset = 0; offset < duration; offset += chunkSize) {
				if (revision !== this.fetchRevision) {
					return [];
				}

				const fetched = await this.fetchChunkGroup(offset, duration);
				if (revision !== this.fetchRevision) {
					return [];
				}

				comments.push(...fetched);
			}

			const result = sortAndDedupeComments(comments);
			if (revision === this.fetchRevision) {
				this.fullFetchResult = result;
			}

			return result;
		})().finally(() => {
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

		const windowDuration = Math.min(600, Math.max(duration - offset, 0));
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
			state.fetchedSourceKeys.add(source.key);
			const fetched = await this.fetchSourceChunk({
				source,
				offset,
				windowDuration,
				sourceOrdinal: sourceOrdinal < 0 ? 0 : sourceOrdinal,
			});
			state.commentCount += fetched.length;
			newComments.push(...fetched);

			if (
				this.isDenseEnough(state.commentCount, windowDuration) ||
				state.fetchedSourceKeys.size >= applicableSources.length
			) {
				state.completed = true;
				break;
			}
		}

		if (state.fetchedSourceKeys.size >= applicableSources.length) {
			state.completed = true;
		}

		return newComments;
	}

	private isDenseEnough(commentCount: number, windowDuration: number) {
		const minutes = Math.max(windowDuration / 60, 1);
		return commentCount / minutes >= 100;
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

			const newComments: NiconicoComment[] = data.packet.map((p) => {
				const c = p.chat;
				const date = parseInt(c.date, 10);
				const date_usec = parseInt(c.date_usec || "0", 10);
				const no = parseInt(c.no, 10);
				const relativeSeconds = date + date_usec / 1_000_000 - source.startAt;
				const mappedTime = this.baseStartAt + relativeSeconds;
				const mappedDate = Math.floor(mappedTime);
				const mappedDateUsec = Math.max(
					0,
					Math.floor((mappedTime - mappedDate) * 1_000_000),
				);
				const vpos = Math.floor(mappedTime * 100);

				return {
					id: buildStableCommentId({
						seconds: mappedDate,
						microseconds: mappedDateUsec,
						no,
						sourceOrdinal,
					}),
					no,
					vpos,
					content: c.content,
					date: mappedDate,
					date_usec: mappedDateUsec,
					mail: c.mail?.split(" ") || [],
					user_id: c.user_id,
					premium: parseInt(c.premium || "0", 10),
					anonymity: parseInt(c.anonymity || "0", 10),
					origin: "ws",
				};
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
