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
