import assert from "node:assert/strict";
import test from "node:test";
import { formatRendererCommentContent } from "../src/plugins/nicojk/renderer-comment-text";

test("excludes comments containing response anchors", () => {
	assert.equal(formatRendererCommentContent(">>100 これは返信"), null);
	assert.equal(formatRendererCommentContent("本文 >>100"), null);
});

test("removes ordinary and h-less URLs from renderer text", () => {
	assert.equal(
		formatRendererCommentContent("公式 https://example.com を見て"),
		"公式 を見て",
	);
	assert.equal(
		formatRendererCommentContent("公式 ttp://example.com を見て"),
		"公式 を見て",
	);
});

test("excludes comments made up only of a URL", () => {
	assert.equal(formatRendererCommentContent("ttps://example.com"), null);
});
