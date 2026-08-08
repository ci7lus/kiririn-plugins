import assert from "node:assert/strict";
import test from "node:test";

import {
	createLiveCommentClient,
	getLiveClientKey,
} from "../src/plugins/nicojk/App";
import { CommentClient } from "../src/plugins/nicojk/comment-client";
import { NiconicoCommentClient } from "../src/plugins/nicojk/niconico-comment-client";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

function source(key: string): ResolvedCommentSource {
	return {
		key,
		kind: "primary",
		jkId: "jk1",
		channelName: "Test",
		startAt: 1,
		endAt: 2,
	};
}

test("live client keys include mode and source key", () => {
	const resolved = source("primary:jk1:na:1");

	assert.equal(
		getLiveClientKey("niconico", resolved),
		"niconico:primary:jk1:na:1",
	);
	assert.notEqual(
		getLiveClientKey("niconico", resolved),
		getLiveClientKey("nx-jikkyo", resolved),
	);
});

test("live client factory selects the configured transport", () => {
	assert.ok(
		createLiveCommentClient("niconico") instanceof NiconicoCommentClient,
	);
	assert.ok(createLiveCommentClient("nx-jikkyo") instanceof CommentClient);
});
