export function buildStableCommentId(params: {
	seconds: number;
	microseconds: number;
	no?: number;
	sourceOrdinal?: number;
}) {
	const microseconds = Math.min(
		Math.max(Math.floor(params.microseconds), 0),
		989_000,
	);
	const sourceOrdinal = Math.min(Math.max(params.sourceOrdinal || 0, 0), 9);
	const serial = Math.abs(params.no || 0) % 1000;

	return (
		params.seconds * 1_000_000 + microseconds + sourceOrdinal * 1000 + serial
	);
}

export function buildMiyouCommentId(params: {
	sourceKey: string;
	commentId: string;
	time: number;
}) {
	let hash = 2_166_136_261;
	const key = `${params.sourceKey}:${params.commentId}:${params.time}`;
	for (const char of key) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}

	// niconicomments はコメント ID に負数を許可しないため、正の合成 ID を使う。
	// ハッシュ値は通常のニコニコ過去ログ ID（Unix time ベース）とは範囲が異なる。
	return Math.abs(hash >>> 0) || 1;
}
