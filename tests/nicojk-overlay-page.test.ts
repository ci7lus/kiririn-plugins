import assert from "node:assert/strict";
import test from "node:test";
import type { NiconicoComment } from "../src/plugins/nicojk/comment-client";
import { getLiveRendererSeedComments } from "../src/plugins/nicojk/components/OverlayPage";

function comment(vpos: number, mail: string[] = []): NiconicoComment {
	return {
		id: vpos,
		no: vpos,
		vpos,
		content: "test",
		date: 0,
		date_usec: 0,
		mail,
		user_id: "test",
		premium: 0,
		anonymity: 1,
		origin: "ws",
	};
}

test("live renderer seeds only comments that can still be drawn", () => {
	const nowVpos = 10_000;
	assert.deepEqual(
		getLiveRendererSeedComments(
			[comment(nowVpos - 426), comment(nowVpos - 425), comment(nowVpos + 200)],
			nowVpos,
		).map((item) => item.id),
		[nowVpos - 425, nowVpos + 200],
	);
});

test("live renderer preserves a visible long comment across a rebuild", () => {
	const nowVpos = 10_000;
	assert.deepEqual(
		getLiveRendererSeedComments(
			[comment(nowVpos - 1_300, ["@12"]), comment(nowVpos - 1_326, ["@12"])],
			nowVpos,
		).map((item) => item.id),
		[nowVpos - 1_300],
	);
});
