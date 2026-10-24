import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLiveCommentSource } from "../src/plugins/nicojk/ng-settings";

test("defaults live comments to nx-jikkyo", () => {
	assert.equal(normalizeLiveCommentSource(undefined), "nx-jikkyo");
	assert.equal(normalizeLiveCommentSource("unexpected"), "nx-jikkyo");
});

test("allows explicit live comment sources", () => {
	assert.equal(normalizeLiveCommentSource("niconico"), "niconico");
	assert.equal(normalizeLiveCommentSource("nx-jikkyo"), "nx-jikkyo");
});

test("normalizes Syobocal defaults and session limits", async () => {
	const { normalizeSettings } = await import(
		"../src/plugins/nicojk/ng-settings"
	);
	assert.equal(normalizeSettings({}).syobocalEnabled, true);
	assert.equal(normalizeSettings({}).replaySessionLimit, 10);
	assert.equal(
		normalizeSettings({ syobocalEnabled: false }).syobocalEnabled,
		false,
	);
	for (const [input, expected] of [
		[0, 0],
		[-1, 0],
		[2.6, 3],
		["12", 12],
		[NaN, 10],
		[Infinity, 10],
		["", 10],
	] as const) {
		assert.equal(
			normalizeSettings({ replaySessionLimit: input }).replaySessionLimit,
			expected,
		);
	}
});
