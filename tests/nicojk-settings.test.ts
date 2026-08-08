import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLiveCommentSource } from "../src/plugins/nicojk/ng-settings";

test("defaults live comments to anonymous niconico", () => {
	assert.equal(normalizeLiveCommentSource(undefined), "niconico");
	assert.equal(normalizeLiveCommentSource("unexpected"), "niconico");
});

test("allows explicit nx-jikkyo live comments", () => {
	assert.equal(normalizeLiveCommentSource("nx-jikkyo"), "nx-jikkyo");
});
