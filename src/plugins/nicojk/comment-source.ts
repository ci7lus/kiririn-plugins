import type { NiconicoComment } from "./comment-client";
import type { NicoJKContext, NicoJKSourceContext } from "./context";

export type CommentSourceOrigin = "niconico" | "miyou";

export const COMMENT_SOURCE_ORIGINS: CommentSourceOrigin[] = [
	"niconico",
	"miyou",
];

export const COMMENT_SOURCE_ORIGIN_LABELS: Record<CommentSourceOrigin, string> =
	{
		niconico: "ニコニコ",
		miyou: "miyou",
	};

export function getCommentSourceOrigin(
	comment: Pick<NiconicoComment, "origin">,
): CommentSourceOrigin {
	return comment.origin === "miyou" ? "miyou" : "niconico";
}

/** チャンネルソースとコメント配信元を組み合わせた表示・フィルター用キー。 */
export function getCommentSourceKey(
	sourceKey: string,
	origin: CommentSourceOrigin,
) {
	return `${sourceKey}::${origin}`;
}

export function getCommentSourceKeyForComment(
	comment: NiconicoComment,
	jkContext: NicoJKContext | null,
) {
	const sourceOrdinal = Math.max(comment.sourceOrdinal || 0, 0);
	const source = jkContext?.sources[sourceOrdinal];
	return source
		? getCommentSourceKey(source.key, getCommentSourceOrigin(comment))
		: null;
}

export function getCommentSourceKeysForSource(source: NicoJKSourceContext) {
	const keys = [getCommentSourceKey(source.key, "niconico")];
	if (source.miyouChannel) {
		keys.push(getCommentSourceKey(source.key, "miyou"));
	}
	return keys;
}

export function getCommentSourceKeys(jkContext: NicoJKContext | null) {
	return jkContext?.sources.flatMap(getCommentSourceKeysForSource) || [];
}
