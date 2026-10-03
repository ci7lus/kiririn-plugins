import assert from "node:assert/strict";
import test from "node:test";
import { Virtualizer } from "@tanstack/react-virtual";
import {
	getCommentRowKey,
	getPendingLiveComments,
	pruneCommentMeasurementCache,
} from "../src/plugins/nicojk/comment-buffer";
import type { NiconicoComment } from "../src/plugins/nicojk/comment-client";

function comment(id: number): NiconicoComment {
	return {
		id,
		no: id,
		vpos: id,
		content: "NG comment",
		date: 0,
		date_usec: 0,
		mail: [],
		user_id: "blocked-user",
		premium: 0,
		anonymity: 1,
	};
}

test("live IDs stay bounded when all incoming comments are filtered out", () => {
	const processedIds = new Set<number>();
	let comments: NiconicoComment[] = [];
	for (let id = 0; id < 10_000; id++) {
		comments = [...comments.slice(-999), comment(id)];
		const pending = getPendingLiveComments(comments, processedIds);
		assert.deepEqual(
			pending.map((item) => item.id),
			[id],
		);
		// The overlay marks NG comments as processed without adding them to the renderer.
		for (const item of pending) processedIds.add(item.id);
		assert.ok(processedIds.size <= 1000);
	}
	assert.deepEqual(getPendingLiveComments(comments, processedIds), []);
	getPendingLiveComments([], processedIds);
	assert.equal(processedIds.size, 0);
});

test("panel retains measured sizes only for comments still in the list", () => {
	const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
		count: 1000,
		getScrollElement: () => null,
		estimateSize: () => 41,
		scrollToFn: () => {},
		observeElementRect: () => {},
		observeElementOffset: () => {},
	});
	let comments = Array.from({ length: 1000 }, (_, id) => comment(id));
	for (let id = 1000; id < 5000; id++) {
		comments = [...comments.slice(1), comment(id)];
		virtualizer.setOptions({
			...virtualizer.options,
			getItemKey: (index) => getCommentRowKey(comments[index]),
		});
		virtualizer.getTotalSize();
		virtualizer.resizeItem(999, 42);
		pruneCommentMeasurementCache(virtualizer.itemSizeCache, comments);
		assert.ok(virtualizer.itemSizeCache.size <= 1000);
		assert.equal(
			virtualizer.itemSizeCache.get(getCommentRowKey(comment(id))),
			42,
		);
	}
	const lastComment = comments.at(-1);
	assert.ok(lastComment);
	pruneCommentMeasurementCache(virtualizer.itemSizeCache, [lastComment]);
	assert.equal(virtualizer.itemSizeCache.size, 1);
	pruneCommentMeasurementCache(virtualizer.itemSizeCache, []);
	assert.equal(virtualizer.itemSizeCache.size, 0);
});
