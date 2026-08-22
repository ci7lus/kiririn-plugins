import assert from "node:assert/strict";
import test from "node:test";
import {
	convertMiyouComment,
	parseMiyouResponse,
} from "../src/plugins/nicojk/miyou-comment-client";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

const PRIMARY: ResolvedCommentSource = {
	key: "primary:jk1:1:1700000000",
	kind: "primary",
	jkId: "jk1",
	channelName: "Primary",
	startAt: 1_700_000_000,
	endAt: 1_700_001_800,
	programStartAt: 1_700_000_000,
};

test("parses Miyou comments and ignores malformed entries", () => {
	assert.deepEqual(
		parseMiyouResponse({
			data: {
				comments: [
					{
						id: "42",
						name: "名無し",
						text: "hello",
						time: "1700000123456",
						email: "sage",
						title: "実況スレ",
					},
					{ text: "", time: 1_700_000_000_000 },
					{ text: "invalid", time: "not-a-time" },
				],
			},
		}),
		[
			{
				id: "42",
				name: "名無し",
				text: "hello",
				time: 1_700_000_123_456,
				email: "sage",
				title: "実況スレ",
			},
		],
	);
	assert.deepEqual(parseMiyouResponse("null"), []);
});

test("converts a primary Miyou comment to the nicojk timeline", () => {
	const comment = convertMiyouComment(
		{
			id: "42",
			name: "名無し",
			text: "hello",
			time: 1_700_000_123_456,
			email: "sage",
			title: "実況スレ",
		},
		PRIMARY,
		0,
	);

	assert.equal(comment.origin, "miyou");
	assert.equal(comment.sourceOrdinal, 0);
	assert.equal(comment.date, 1_700_000_123);
	assert.equal(comment.date_usec, 456_000);
	assert.equal(comment.vpos, 170000012345);
	assert.deepEqual(comment.mail, ["sage"]);
	assert.ok(comment.id > 0);
});

test("anchors a Miyou simulcast comment to the primary timeline", () => {
	const simulcast: ResolvedCommentSource = {
		...PRIMARY,
		key: "replay:jk2:2:1700086400",
		kind: "replay",
		jkId: "jk2",
		channelName: "Simulcast",
		startAt: 1_700_086_400,
		endAt: 1_700_088_200,
		programStartAt: 1_700_086_400,
	};
	const comment = convertMiyouComment(
		{
			id: "43",
			name: "名無し",
			text: "hello",
			time: 1_700_086_460_000,
			email: "",
			title: "実況スレ",
		},
		simulcast,
		1,
		PRIMARY,
	);

	assert.equal(comment.vpos, 1_700_000_060 * 100);
});
