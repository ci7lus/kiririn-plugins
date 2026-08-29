import type { NiconicoComment } from "./comment-client";
import type { NicoJKSettings } from "./ng-settings";

const DUPLICATE_TIME_WINDOW_SECONDS = 10 * 60;

function getUserCommentKey(comment: NiconicoComment, includeSource: boolean) {
	if (
		!comment.user_id ||
		typeof comment.content !== "string" ||
		comment.content.length === 0
	) {
		return null;
	}

	const source = includeSource
		? `${Math.max(comment.sourceOrdinal || 0, 0)}\u0000`
		: "";
	return `${source}${comment.user_id}\u0000${comment.content}`;
}

function markComments(
	comments: NiconicoComment[],
	getKey: (comment: NiconicoComment) => string | null,
) {
	const latestTimestamps = new Map<string, number>();
	return comments.map((comment) => {
		const key = getKey(comment);
		const timestamp = comment.date + comment.date_usec / 1_000_000;
		const latestTimestamp = key != null ? latestTimestamps.get(key) : undefined;
		const isDuplicate =
			latestTimestamp != null &&
			timestamp >= latestTimestamp &&
			timestamp - latestTimestamp <= DUPLICATE_TIME_WINDOW_SECONDS;
		if (
			key != null &&
			(latestTimestamp == null || timestamp >= latestTimestamp)
		) {
			latestTimestamps.set(key, timestamp);
		}

		return comment.isDuplicate === isDuplicate
			? comment
			: { ...comment, isDuplicate };
	});
}

/** ライブバッファ内で10分以内に繰り返された同じID・本文を自動NGとしてマークする。 */
export function markLiveDuplicateComments(comments: NiconicoComment[]) {
	return markComments(comments, (comment) => getUserCommentKey(comment, false));
}

/**
 * 同一過去ログ内で10分以内に繰り返された同じID・本文（4文字以上）を
 * 自動NGとしてマークする。sourceOrdinal が過去ログの単位を表す。
 */
export function markRecordedDuplicateComments(comments: NiconicoComment[]) {
	return markComments(comments, (comment) => {
		if (typeof comment.content !== "string") {
			return null;
		}
		if (Array.from(comment.content).length < 4) {
			return null;
		}
		return getUserCommentKey(comment, true);
	});
}

export type CommentNGReason = "duplicate" | "id" | "word";

const COMMENT_NG_REASON_LABELS: Record<CommentNGReason, string> = {
	duplicate: "重複コメント",
	id: "NG ID",
	word: "NGワード",
};

function traceNGComment(
	comment: NiconicoComment,
	reasons: CommentNGReason[],
	tracedCommentIds?: Set<number>,
) {
	if (tracedCommentIds) {
		if (tracedCommentIds.has(comment.id)) {
			return;
		}
		tracedCommentIds.add(comment.id);
	}
	console.trace("[NicoJK] NG対象コメント", {
		reasons: reasons.map((reason) => COMMENT_NG_REASON_LABELS[reason]),
		comment: { ...comment },
	});
}

export interface RecordedNGTraceState {
	scopeKey: string | null;
	commentCount: number | null;
	/** 現在の録画範囲でtrace済みのコメントID。再生対象変更時に破棄する。 */
	tracedCommentIds: Set<number>;
}

export function createRecordedNGTraceState(): RecordedNGTraceState {
	return {
		scopeKey: null,
		commentCount: null,
		tracedCommentIds: new Set(),
	};
}

export function getCommentNGReasons(
	comment: NiconicoComment,
	settings: Pick<NicoJKSettings, "deduplicateComments" | "ngIds" | "ngWords">,
): CommentNGReason[] {
	const reasons: CommentNGReason[] = [];
	if (settings.deduplicateComments && comment.isDuplicate) {
		reasons.push("duplicate");
	}
	if (comment.user_id && settings.ngIds.includes(comment.user_id)) {
		reasons.push("id");
	}
	if (
		typeof comment.content === "string" &&
		settings.ngWords.some((word) => comment.content.includes(word))
	) {
		reasons.push("word");
	}
	return reasons;
}

export function isCommentNGBySettings(
	comment: NiconicoComment,
	settings: Pick<NicoJKSettings, "deduplicateComments" | "ngIds" | "ngWords">,
) {
	const reasons = getCommentNGReasons(comment, settings);
	return reasons.length > 0;
}

/** 件数変化の検出と再生対象単位のトレース抑制をまとめて行う。 */
export function traceRecordedNGCommentsIfCountChanged(
	comments: NiconicoComment[],
	settings: Pick<NicoJKSettings, "deduplicateComments" | "ngIds" | "ngWords">,
	state: RecordedNGTraceState,
	scopeKey: string | null,
) {
	if (state.scopeKey !== scopeKey) {
		state.scopeKey = scopeKey;
		state.commentCount = null;
		state.tracedCommentIds.clear();
	}
	if (state.commentCount === comments.length) {
		return false;
	}
	state.commentCount = comments.length;
	for (const comment of comments) {
		const reasons = getCommentNGReasons(comment, settings);
		if (reasons.length > 0) {
			traceNGComment(comment, reasons, state.tracedCommentIds);
		}
	}
	return true;
}
