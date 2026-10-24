import assert from "node:assert/strict";
import test from "node:test";
import {
	type ChapterComment,
	detectChapterPoints,
	normalizeChapterLabel,
} from "../src/plugins/nicojk/chapter-comments";

test("chapter detection ignores omitted and undefined content", () => {
	const comments: ChapterComment[] = [
		{ id: 1, vpos: 100 },
		{ id: 2, vpos: 200, content: undefined },
		{ id: 3, vpos: 300, content: "OP" },
	];
	const options = {
		startAt: 0,
		duration: 100,
		windowSeconds: 10,
		cooldownSeconds: 60,
		minimumCount: 1,
	};
	assert.deepEqual(detectChapterPoints(comments, options), [
		{ key: "0:3", label: "OP", relativeSec: 3, syncSec: 3 },
	]);
});

test("chapter labels still normalize valid comment content", () => {
	assert.equal(normalizeChapterLabel("  ＯＰ  "), "OP");
	assert.equal(normalizeChapterLabel("ｷﾀｰ"), "ｷﾀｰ");
	assert.equal(normalizeChapterLabel(""), null);
	assert.equal(normalizeChapterLabel("通常のコメント"), null);
});
