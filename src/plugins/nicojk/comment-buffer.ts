import type { NiconicoComment } from "./comment-client";

/** Forget IDs evicted from the live buffer, including comments filtered out by NG settings. */
export function getPendingLiveComments(
	comments: NiconicoComment[],
	processedIds: Set<number>,
) {
	const retainedIds = new Set(comments.map((comment) => comment.id));
	for (const id of processedIds) {
		if (!retainedIds.has(id)) processedIds.delete(id);
	}
	return comments.filter((comment) => !processedIds.has(comment.id));
}

export function getCommentRowKey(comment: NiconicoComment) {
	return `${comment.no}-${comment.id}`;
}

/** TanStack Virtual keeps measured sizes after rows leave the list unless we remove them. */
export function pruneCommentMeasurementCache(
	cache: Map<string | number | bigint, number>,
	comments: NiconicoComment[],
) {
	if (cache.size === 0) return;
	const staleKeys = new Set(cache.keys());
	for (const comment of comments) {
		staleKeys.delete(getCommentRowKey(comment));
		if (staleKeys.size === 0) return;
	}
	for (const key of staleKeys) cache.delete(key);
}
