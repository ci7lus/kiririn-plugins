import assert from "node:assert/strict";
import test from "node:test";
import {
	getLiveCommentVpos,
	type NiconicoComment,
} from "../src/plugins/nicojk/comment-client";
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

test("live renderer skips comments delivered long after they were posted", () => {
	const postedAt = 1_700_000_000;
	const receivedAt = (postedAt + 3_600) * 1_000;
	assert.deepEqual(
		getLiveRendererSeedComments(
			[comment(getLiveCommentVpos(receivedAt, postedAt, 0))],
			Math.floor(receivedAt / 10),
		),
		[],
	);
});

test("live renderer draws comments delivered shortly after they were posted", () => {
	const postedAt = 1_700_000_000;
	const receivedAt = (postedAt + 5) * 1_000;
	const vpos = getLiveCommentVpos(receivedAt, postedAt, 0);
	assert.deepEqual(
		getLiveRendererSeedComments(
			[comment(vpos)],
			Math.floor(receivedAt / 10),
		).map((item) => item.vpos),
		[vpos],
	);
});
