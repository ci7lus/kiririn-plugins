import assert from "node:assert/strict";
import test from "node:test";

import type { NiconicoComment } from "../src/plugins/nicojk/comment-client";
import {
	getCommentSourceKey,
	getCommentSourceKeyForComment,
	getCommentSourceKeys,
} from "../src/plugins/nicojk/comment-source";
import type { NicoJKContext } from "../src/plugins/nicojk/context";

const CONTEXT: NicoJKContext = {
	jkId: "jk1",
	channelName: "Primary",
	startAt: 1_700_000_000,
	endAt: 1_700_001_800,
	programStartAt: 1_700_000_000,
	sources: [
		{
			key: "primary",
			jkId: "jk1",
			channelName: "Primary",
			kind: "primary",
			miyouChannel: "Primary",
			startAt: 1_700_000_000,
			endAt: 1_700_001_800,
		},
		{
			key: "replay",
			jkId: "jk2",
			channelName: "Replay",
			kind: "replay",
			startAt: 1_700_000_000,
			endAt: 1_700_001_800,
		},
	],
};

function comment(origin: NiconicoComment["origin"], sourceOrdinal = 0) {
	return {
		id: 1,
		no: 1,
		vpos: 1,
		content: "comment",
		date: 1,
		date_usec: 0,
		mail: [],
		user_id: "user",
		premium: 0,
		anonymity: 0,
		origin,
		sourceOrdinal,
	} satisfies NiconicoComment;
}

test("comment source keys include the feed origin", () => {
	assert.equal(getCommentSourceKey("primary", "niconico"), "primary::niconico");
	assert.equal(getCommentSourceKey("primary", "miyou"), "primary::miyou");
	assert.equal(
		getCommentSourceKeyForComment(comment("miyou"), CONTEXT),
		"primary::miyou",
	);
	assert.equal(
		getCommentSourceKeyForComment(comment("broadcast", 1), CONTEXT),
		"replay::niconico",
	);
});

test("sources without a Miyou channel expose only the NicoNico feed", () => {
	assert.deepEqual(getCommentSourceKeys(CONTEXT), [
		"primary::niconico",
		"primary::miyou",
		"replay::niconico",
	]);
});
