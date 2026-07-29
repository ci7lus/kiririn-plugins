export const CHAPTER_CANDIDATES = [
	{ pattern: /^A$/i, label: "A" },
	{ pattern: /^B$/i, label: "B" },
	{ pattern: /^C$/i, label: "C" },
	{ pattern: /^D$/i, label: "D" },
	{ pattern: /^出?OP$/i, label: "OP" },
	{ pattern: /^ED$/i, label: "ED" },
	{ pattern: /^ここ$/, label: "ここ" },
	{ pattern: /^ｷﾀ[‐‑‒–—―−ーｰ－─━〜～-]+/, label: "ｷﾀｰ" },
] as const;

export type ChapterLabel = (typeof CHAPTER_CANDIDATES)[number]["label"];

export type ChapterComment = {
	id: number;
	vpos: number;
	content: string;
	sourceOrdinal?: number;
};

export type ChapterPoint = {
	key: string;
	label: ChapterLabel;
	/** チャプターへシークする際に使う、バケット内の最初のコメント位置 */
	relativeSec: number;
	/** ソース間同期に使う、代表ラベルのコメント位置の中央値 */
	syncSec: number;
};

export type ChapterDetectionOptions = {
	startAt: number;
	duration: number;
	windowSeconds: number;
	cooldownSeconds: number;
	minimumCount: number;
	sourceOrdinal?: number;
};

type ChapterMatch = {
	label: ChapterLabel;
	relativeSec: number;
	commentId: number;
};

type ChapterBucket = {
	matches: ChapterMatch[];
	counts: Map<ChapterLabel, number>;
};

export function normalizeChapterLabel(content: string): ChapterLabel | null {
	// Keep half-width kana intact while normalizing full-width Latin candidates.
	const normalized = content
		.trim()
		.replace(/[Ａ-Ｚａ-ｚ]/g, (char) =>
			String.fromCharCode(char.charCodeAt(0) - 0xfee0),
		);

	return (
		CHAPTER_CANDIDATES.find((candidate) => candidate.pattern.test(normalized))
			?.label || null
	);
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[middle - 1] + sorted[middle]) / 2;
	}
	return sorted[middle];
}

/**
 * コメントの集中をチャプター点へ変換する。
 * 戻り値は再生時刻の昇順。
 */
export function detectChapterPoints(
	comments: ChapterComment[],
	options: ChapterDetectionOptions,
): ChapterPoint[] {
	const {
		startAt,
		duration,
		windowSeconds,
		cooldownSeconds,
		minimumCount,
		sourceOrdinal,
	} = options;
	if (
		duration <= 0 ||
		windowSeconds <= 0 ||
		minimumCount <= 0 ||
		!Number.isFinite(startAt)
	) {
		return [];
	}

	const buckets = new Map<number, ChapterBucket>();

	for (const comment of comments) {
		if (
			sourceOrdinal != null &&
			Math.max(comment.sourceOrdinal || 0, 0) !== sourceOrdinal
		) {
			continue;
		}

		const label = normalizeChapterLabel(comment.content);
		if (!label) {
			continue;
		}

		const relativeSec = comment.vpos / 100 - startAt;
		if (
			!Number.isFinite(relativeSec) ||
			relativeSec < 0 ||
			relativeSec > duration
		) {
			continue;
		}

		const bucketIndex = Math.floor(relativeSec / windowSeconds);
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
			if (bucket.matches.length < minimumCount) {
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
			const dominantLabels = new Set(
				[...bucket.counts.entries()]
					.filter(([, count]) => count === highestCount)
					.map(([label]) => label),
			);
			const dominantLabel =
				sortedMatches.find((match) => dominantLabels.has(match.label))?.label ||
				anchor.label;
			const dominantMatches = sortedMatches.filter(
				(match) => match.label === dominantLabel,
			);

			return [
				{
					key: `${bucketIndex}:${anchor.commentId}`,
					label: dominantLabel,
					relativeSec: anchor.relativeSec,
					syncSec: median(dominantMatches.map((match) => match.relativeSec)),
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
		nextAvailableSec = candidate.relativeSec + cooldownSeconds;
	}

	return filtered;
}
