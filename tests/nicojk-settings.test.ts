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
