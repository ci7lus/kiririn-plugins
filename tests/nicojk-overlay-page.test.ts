import assert from "node:assert/strict";
import test from "node:test";
import {
	LiveCommentVposClock,
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

function drawableAfterDelivery(
	clock: LiveCommentVposClock,
	receivedAt: number,
	postedAt: number,
) {
	return (
		getLiveRendererSeedComments(
			[comment(clock.getVpos(receivedAt, postedAt, 0))],
			Math.floor(receivedAt / 10),
		).length === 1
	);
}

const SERVER_NOW = 1_700_000_000;

for (const [label, skewSeconds] of [
	["matches the server", 0],
	["runs an hour ahead of the server", 3_600],
	["runs an hour behind the server", -3_600],
] as const) {
	test(`live renderer draws fresh comments and skips backlog when the local clock ${label}`, () => {
		const clock = new LiveCommentVposClock();
		const toLocalMs = (serverSeconds: number) =>
			(serverSeconds + skewSeconds) * 1_000;

		assert.equal(
			drawableAfterDelivery(clock, toLocalMs(SERVER_NOW), SERVER_NOW),
			true,
			"fresh comment before sleep",
		);
		const wokeAt = SERVER_NOW + 7_200;
		assert.equal(
			drawableAfterDelivery(clock, toLocalMs(wokeAt), SERVER_NOW + 60),
			false,
			"comment posted during sleep",
		);
		assert.equal(
			drawableAfterDelivery(clock, toLocalMs(wokeAt), wokeAt - 5),
			true,
			"fresh comment after waking",
		);
	});
}

test("live renderer draws the first comment of a session without a delay baseline", () => {
	assert.equal(
		drawableAfterDelivery(
			new LiveCommentVposClock(),
			(SERVER_NOW + 60) * 1_000,
			SERVER_NOW,
		),
		true,
	);
});

test("live vpos falls back to receive time when the post time is missing", () => {
	const clock = new LiveCommentVposClock();
	const receivedAt = SERVER_NOW * 1_000;
	assert.equal(
		clock.getVpos(receivedAt, Number.NaN, 0),
		Math.floor(receivedAt / 10) + 200,
	);
	assert.equal(drawableAfterDelivery(clock, receivedAt, SERVER_NOW), true);
});
