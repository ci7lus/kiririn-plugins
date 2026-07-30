import {
	type ChapterLabel,
	type ChapterPoint,
	detectChapterPoints,
} from "./chapter-comments";
import type { NiconicoComment } from "./comment-client";
import type { ResolvedCommentSource } from "./source-resolver";

const MAX_CORRECTION_SECONDS = 15 * 60;
const STRONG_SINGLE_ANCHOR_LABELS = new Set<ChapterLabel>([
	"A",
	"B",
	"C",
	"D",
	"OP",
	"ED",
]);

export type ChapterSourceSyncOptions = {
	windowSeconds: number;
	cooldownSeconds: number;
	minimumCount: number;
	disabledSourceOrdinals?: ReadonlySet<number>;
};

export type ChapterSourceCorrection = {
	sourceOrdinal: number;
	offsetSeconds: number;
	matchedLabels: ChapterLabel[];
};

type OffsetCandidate = {
	label: ChapterLabel;
	offsetSeconds: number;
};

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[middle - 1] + sorted[middle]) / 2;
	}
	return sorted[middle];
}

function collectUniqueLabelOffsets(
	primaryPoints: ChapterPoint[],
	secondaryPoints: ChapterPoint[],
): OffsetCandidate[] {
	const candidates: OffsetCandidate[] = [];

	for (const label of CHAPTER_LABELS) {
		const primaryMatches = primaryPoints.filter(
			(point) => point.label === label,
		);
		const secondaryMatches = secondaryPoints.filter(
			(point) => point.label === label,
		);
		if (primaryMatches.length !== 1 || secondaryMatches.length !== 1) {
			continue;
		}

		const offsetSeconds =
			primaryMatches[0].syncSec - secondaryMatches[0].syncSec;
		if (
			Number.isFinite(offsetSeconds) &&
			Math.abs(offsetSeconds) <= MAX_CORRECTION_SECONDS
		) {
			candidates.push({ label, offsetSeconds });
		}
	}

	return candidates;
}

const CHAPTER_LABELS: ChapterLabel[] = [
	"A",
	"B",
	"C",
	"D",
	"OP",
	"ED",
	"ここ",
	"ｷﾀｰ",
];

function findConsistentOffsets(
	candidates: OffsetCandidate[],
	toleranceSeconds: number,
): OffsetCandidate[] {
	let best: OffsetCandidate[] = [];

	for (const candidate of candidates) {
		const cluster = candidates.filter(
			(other) =>
				Math.abs(other.offsetSeconds - candidate.offsetSeconds) <=
				toleranceSeconds,
		);
		if (cluster.length > best.length) {
			best = cluster;
			continue;
		}
		if (cluster.length < best.length || cluster.length === 0) {
			continue;
		}

		const clusterOffset = Math.abs(
			median(cluster.map((item) => item.offsetSeconds)),
		);
		const bestOffset = Math.abs(median(best.map((item) => item.offsetSeconds)));
		// 同数なら「補正なし」に近い候補を優先し、曖昧な大幅補正を避ける。
		if (clusterOffset < bestOffset) {
			best = cluster;
		}
	}

	return best;
}

export function estimateChapterSourceCorrection(
	primaryPoints: ChapterPoint[],
	secondaryPoints: ChapterPoint[],
	windowSeconds: number,
): Omit<ChapterSourceCorrection, "sourceOrdinal"> | null {
	if (primaryPoints.length === 0 || secondaryPoints.length === 0) {
		return null;
	}

	const candidates = collectUniqueLabelOffsets(primaryPoints, secondaryPoints);
	if (candidates.length === 0) {
		return null;
	}

	const consistent = findConsistentOffsets(
		candidates,
		Math.max(windowSeconds, 5),
	);
	if (
		consistent.length === 0 ||
		(candidates.length > 1 && consistent.length < 2) ||
		(consistent.length === 1 &&
			!STRONG_SINGLE_ANCHOR_LABELS.has(consistent[0].label))
	) {
		return null;
	}

	const offsetSeconds = median(
		consistent.map((candidate) => candidate.offsetSeconds),
	);
	// 同じ判定幅に収まる差はコメント反応速度の揺らぎとして扱う。
	if (Math.abs(offsetSeconds) <= windowSeconds) {
		return null;
	}

	return {
		offsetSeconds: Math.round(offsetSeconds * 100) / 100,
		matchedLabels: consistent.map((candidate) => candidate.label),
	};
}

export function synchronizeCommentSourcesByChapters(
	comments: NiconicoComment[],
	sources: ResolvedCommentSource[],
	options: ChapterSourceSyncOptions,
): {
	comments: NiconicoComment[];
	corrections: ChapterSourceCorrection[];
} {
	const primary = sources[0];
	if (!primary || sources.length < 2 || comments.length === 0) {
		return { comments, corrections: [] };
	}

	const startAt = primary.startAt;
	const duration = Math.max(primary.endAt - primary.startAt, 0);
	const detectionOptions = {
		startAt,
		duration,
		windowSeconds: options.windowSeconds,
		cooldownSeconds: options.cooldownSeconds,
		minimumCount: options.minimumCount,
	};
	const primaryPoints = detectChapterPoints(comments, {
		...detectionOptions,
		sourceOrdinal: 0,
	});
	if (primaryPoints.length === 0) {
		return { comments, corrections: [] };
	}

	const corrections: ChapterSourceCorrection[] = [];
	for (
		let sourceOrdinal = 1;
		sourceOrdinal < sources.length;
		sourceOrdinal += 1
	) {
		const secondaryPoints = detectChapterPoints(comments, {
			...detectionOptions,
			sourceOrdinal,
		});
		const correction = estimateChapterSourceCorrection(
			primaryPoints,
			secondaryPoints,
			options.windowSeconds,
		);
		if (correction) {
			corrections.push({ sourceOrdinal, ...correction });
		}
	}

	if (corrections.length === 0) {
		return { comments, corrections };
	}

	const offsetsBySource = new Map(
		corrections.flatMap((correction) =>
			options.disabledSourceOrdinals?.has(correction.sourceOrdinal)
				? []
				: [
						[
							correction.sourceOrdinal,
							Math.round(correction.offsetSeconds * 100),
						] as const,
					],
		),
	);
	return {
		comments: comments.map((comment) => {
			const sourceOrdinal = Math.max(comment.sourceOrdinal || 0, 0);
			const offset = offsetsBySource.get(sourceOrdinal);
			return offset == null
				? comment
				: {
						...comment,
						vpos: comment.vpos + offset,
					};
		}),
		corrections,
	};
}
