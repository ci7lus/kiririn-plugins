import axios from "axios";
import type { NiconicoComment } from "./comment-client";

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

export class KakologManager {
	private comments: NiconicoComment[] = [];
	private fetchedChunks: Set<number> = new Set();
	private jkId: string | null = null;

	public setJkId(jkId: string) {
		if (this.jkId !== jkId) {
			this.jkId = jkId;
			this.comments = [];
			this.fetchedChunks.clear();
		}
	}

	public clearCache() {
		this.comments = [];
		this.fetchedChunks.clear();
	}

	public async fetchIfNeeded(
		startTimeUnix: number,
		playerTime: number,
		duration: number,
	): Promise<NiconicoComment[]> {
		if (!this.jkId) return [];

		// Fetch in 10-minute chunks (600 seconds)
		const chunkSize = 600;
		const currentChunkStart = Math.floor(playerTime / chunkSize) * chunkSize;

		const tasks = [];
		if (currentChunkStart < duration) {
			tasks.push(this.fetchChunk(startTimeUnix, currentChunkStart));
		}
		if (currentChunkStart + chunkSize < duration) {
			tasks.push(this.fetchChunk(startTimeUnix, currentChunkStart + chunkSize));
		}

		const results = await Promise.all(tasks);
		return results.flat();
	}

	private async fetchChunk(
		startTimeUnix: number,
		offset: number,
	): Promise<NiconicoComment[]> {
		if (!this.jkId || this.fetchedChunks.has(offset)) return [];
		this.fetchedChunks.add(offset);

		const start = startTimeUnix + offset;
		const end = start + 600;

		try {
			console.log(
				`[Kakolog] Fetching chunk: offset=${offset} (${new Date(start * 1000).toLocaleString()})`,
			);
			const response = await axios.get<KakologResponse | { error: string }>(
				`https://jikkyo.tsukumijima.net/api/kakolog/${this.jkId}`,
				{
					params: {
						format: "json",
						starttime: start,
						endtime: end,
					},
				},
			);

			const data = response.data;
			if ("error" in data) {
				console.error("[Kakolog] API Error", data.error);
				return [];
			}

			const newComments: NiconicoComment[] = data.packet.map((p) => {
				const c = p.chat;
				const date = parseInt(c.date, 10);
				const date_usec = parseInt(c.date_usec || "0", 10);
				const no = parseInt(c.no, 10);

				// Niconico's official vpos is often "ms from start / 10".
				const vpos = Math.floor(date * 100 + date_usec / 10000);

				return {
					id: no || date * 1000 + date_usec / 1000,
					no: no,
					vpos: vpos,
					content: c.content,
					date: date,
					date_usec: date_usec,
					mail: c.mail?.split(" ") || [],
					user_id: c.user_id,
					premium: parseInt(c.premium || "0", 10),
					anonymity: parseInt(c.anonymity || "0", 10),
					origin: "ws", // reusing display logic
				};
			});

			this.comments = [...this.comments, ...newComments]
				.filter((c, i, self) => self.findIndex((t) => t.id === c.id) === i)
				.sort((a, b) => a.date - b.date || a.date_usec - b.date_usec);

			return newComments;
		} catch (e) {
			console.error("[Kakolog] Fetch failed", e);
			this.fetchedChunks.delete(offset);
			return [];
		}
	}
}
