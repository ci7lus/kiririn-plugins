import assert from "node:assert/strict";
import test from "node:test";

import { KakologManager } from "../src/plugins/nicojk/kakolog-manager";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

test("retries a recording that is too recent for the kakolog API", async (t) => {
	const originalNow = Date.now;
	const originalFetch = globalThis.fetch;
	const minuteStart = 1_700_000_040;
	let now = minuteStart + 45;
	let fetchCount = 0;

	Date.now = () => now * 1000;
	globalThis.fetch = async () => {
		fetchCount += 1;
		return new Response(
			JSON.stringify({
				packet: [
					{
						chat: {
							id: "1",
							no: "1",
							vpos: "0",
							content: "開始直後のコメント",
							date: String(minuteStart + 41),
							date_usec: "0",
							mail: "",
							user_id: "user",
						},
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	t.after(() => {
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
	});

	const source: ResolvedCommentSource = {
		key: `primary:jk1:na:${minuteStart + 40}`,
		kind: "primary",
		jkId: "jk1",
		channelName: "Primary",
		startAt: minuteStart + 40,
		endAt: minuteStart + 45,
		programStartAt: minuteStart + 40,
	};
	const manager = new KakologManager();
	manager.setSources([source]);

	assert.deepEqual(await manager.fetchWithLimit(5), []);
	assert.equal(fetchCount, 0);
	assert.equal(manager.isFullyCompleted(), false);
	assert.equal(manager.hasPendingInitialSourceFetch(), true);

	now = minuteStart + 65;
	const comments = await manager.fetchWithLimit(5);

	assert.equal(fetchCount, 1);
	assert.equal(comments.length, 1);
	assert.equal(comments[0]?.content, "開始直後のコメント");
	assert.equal(manager.isFullyCompleted(), true);
	assert.equal(manager.hasPendingInitialSourceFetch(), false);
});
