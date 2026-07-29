import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeCommentSourcesByChapters } from "../src/plugins/nicojk/chapter-source-sync";
import type { NiconicoComment } from "../src/plugins/nicojk/comment-client";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

const START_AT = 1_700_000_000;
const SYNC_OPTIONS = {
	windowSeconds: 10,
	cooldownSeconds: 60,
	minimumCount: 3,
};

const SOURCES: ResolvedCommentSource[] = [
	{
		key: "primary",
		kind: "primary",
		jkId: "jk1",
		channelName: "Primary",
		startAt: START_AT,
		endAt: START_AT + 1800,
	},
	{
		key: "replay",
		kind: "replay",
		jkId: "jk2",
		channelName: "Replay",
		startAt: START_AT + 86400,
		endAt: START_AT + 86400 + 1800,
	},
];

let nextId = 1;

function comment(
	sourceOrdinal: number,
	relativeSec: number,
	content: string,
): NiconicoComment {
	return {
		id: nextId++,
		no: nextId,
		vpos: Math.round((START_AT + relativeSec) * 100),
		content,
		date: START_AT + relativeSec,
		date_usec: 0,
		mail: [],
		user_id: "",
		premium: 0,
		anonymity: 0,
		sourceOrdinal,
	};
}

function chapter(
	sourceOrdinal: number,
	relativeSec: number,
	label: string,
): NiconicoComment[] {
	return [
		comment(sourceOrdinal, relativeSec, label),
		comment(sourceOrdinal, relativeSec + 1, label),
		comment(sourceOrdinal, relativeSec + 2, label),
	];
}

test("Primary の複数チャプター位置を基準に 3 分遅いソースを補正する", () => {
	const secondaryBody = comment(1, 600, "本編コメント");
	const comments = [
		...chapter(0, 300, "OP"),
		...chapter(0, 900, "B"),
		...chapter(1, 480, "OP"),
		...chapter(1, 1080, "B"),
		secondaryBody,
	];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, [
		{
			sourceOrdinal: 1,
			offsetSeconds: -180,
			matchedLabels: ["B", "OP"],
		},
	]);
	assert.equal(
		synchronized.comments.find((item) => item.id === secondaryBody.id)?.vpos,
		secondaryBody.vpos - 18000,
	);
	assert.equal(synchronized.comments[0], comments[0]);
});

test("Primary にチャプターが無ければ他ソースを補正しない", () => {
	const comments = [comment(0, 300, "通常コメント"), ...chapter(1, 480, "OP")];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, []);
	assert.equal(synchronized.comments, comments);
});

test("複数チャプターの差分が一致しない場合は補正しない", () => {
	const comments = [
		...chapter(0, 300, "OP"),
		...chapter(0, 900, "ED"),
		...chapter(1, 480, "OP"),
		...chapter(1, 900, "ED"),
	];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, []);
	assert.equal(synchronized.comments, comments);
});

test("単独の OP は補正に使うが、反応速度程度の差は無視する", () => {
	const delayed = synchronizeCommentSourcesByChapters(
		[...chapter(0, 300, "OP"), ...chapter(1, 480, "OP")],
		SOURCES,
		SYNC_OPTIONS,
	);
	assert.equal(delayed.corrections[0]?.offsetSeconds, -180);

	const nearbyComments = [...chapter(0, 300, "OP"), ...chapter(1, 307, "OP")];
	const nearby = synchronizeCommentSourcesByChapters(
		nearbyComments,
		SOURCES,
		SYNC_OPTIONS,
	);
	assert.deepEqual(nearby.corrections, []);
	assert.equal(nearby.comments, nearbyComments);
});

test("単独の「ここ」は誤補正を避けるため同期基準にしない", () => {
	const comments = [...chapter(0, 300, "ここ"), ...chapter(1, 480, "ここ")];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, []);
});

test("無効化したソースは補正状態を残したまま vpos へ適用しない", () => {
	const secondaryBody = comment(1, 600, "本編コメント");
	const comments = [
		...chapter(0, 300, "OP"),
		...chapter(1, 480, "OP"),
		secondaryBody,
	];

	const synchronized = synchronizeCommentSourcesByChapters(comments, SOURCES, {
		...SYNC_OPTIONS,
		disabledSourceOrdinals: new Set([1]),
	});

	assert.equal(synchronized.corrections[0]?.offsetSeconds, -180);
	assert.equal(
		synchronized.comments.find((item) => item.id === secondaryBody.id)?.vpos,
		secondaryBody.vpos,
	);
});
