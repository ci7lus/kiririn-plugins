import assert from "node:assert/strict";
import test from "node:test";
import { KakologManager } from "../src/plugins/nicojk/kakolog-manager";
import { clearMiyouAuth } from "../src/plugins/nicojk/miyou-comment-client";
import { getSettings, saveSettings } from "../src/plugins/nicojk/ng-settings";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

function createSource(): ResolvedCommentSource {
	return {
		key: "primary:jk1:na:1700000000",
		kind: "primary",
		jkId: "jk1",
		channelName: "Primary",
		startAt: 1_700_000_000,
		endAt: 1_700_001_800,
		programStartAt: 1_700_000_000,
	};
}

function commentResponse(content: string | null) {
	return new Response(
		JSON.stringify({
			packet:
				content == null
					? []
					: [
							{
								chat: {
									no: "1",
									content,
									date: "1700000001",
									mail: "",
									user_id: "user",
								},
							},
						],
		}),
		{ status: 200 },
	);
}

test("does not complete an empty source interval before timing arrives", async (t) => {
	const originalFetch = globalThis.fetch;
	const requestedUrls: URL[] = [];
	globalThis.fetch = async (input) => {
		requestedUrls.push(new URL(String(input)));
		return commentResponse("取得できるコメント");
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const source = createSource();
	const manager = new KakologManager();
	manager.setSources([{ ...source, endAt: source.startAt }]);
	assert.deepEqual(await manager.fetchWithLimit(1800), []);
	assert.equal(requestedUrls.length, 0);
	assert.equal(manager.isFullyCompleted(), false);

	manager.setSources([source]);
	assert.equal(manager.hasPendingInitialSourceFetch(), false);
	const comments = await manager.fetchWithLimit(1800);
	assert.equal(requestedUrls.length, 1);
	assert.equal(
		requestedUrls[0]?.searchParams.get("endtime"),
		String(source.endAt),
	);
	assert.equal(comments[0]?.content, "取得できるコメント");
	assert.equal(manager.isFullyCompleted(), true);
});

test("refetches a completed empty result when the same source interval grows", async (t) => {
	const originalFetch = globalThis.fetch;
	let fetchCount = 0;
	globalThis.fetch = async () => {
		fetchCount += 1;
		return commentResponse(fetchCount === 1 ? null : "更新後のコメント");
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const source = createSource();
	const manager = new KakologManager();
	manager.setSources([{ ...source, endAt: source.startAt + 5 }]);
	assert.deepEqual(await manager.fetchWithLimit(5), []);
	assert.equal(manager.isFullyCompleted(), true, "正常な0件の応答は完了にする");

	manager.setSources([source]);
	assert.equal(manager.isFullyCompleted(), false);
	assert.equal(manager.hasPendingInitialSourceFetch(), false);
	const comments = await manager.fetchWithLimit(1800);
	assert.equal(fetchCount, 2);
	assert.equal(comments[0]?.content, "更新後のコメント");
	assert.equal(manager.isFullyCompleted(), true);
});

test("preserves completed sources when an unchanged source is appended", async (t) => {
	const originalFetch = globalThis.fetch;
	const requestedChannels: string[] = [];
	globalThis.fetch = async (input) => {
		const channel = new URL(String(input)).pathname.split("/").at(-1) || "";
		requestedChannels.push(channel);
		return commentResponse(channel);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const source = createSource();
	const manager = new KakologManager();
	manager.setSources([source]);
	await manager.fetchWithLimit(1800);
	manager.setSources([
		source,
		{ ...source, key: "replay:jk2:na:1700000000", jkId: "jk2", kind: "replay" },
	]);
	assert.equal(manager.hasPendingInitialSourceFetch(), true);
	const comments = await manager.fetchWithLimit(1800);
	assert.deepEqual(requestedChannels, ["jk1", "jk2"]);
	assert.deepEqual(
		comments.map((comment) => comment.content),
		["jk1", "jk2"],
	);
	assert.equal(manager.isFullyCompleted(), true);
});

test("discards an in-flight result after the same source interval changes", async (t) => {
	const originalFetch = globalThis.fetch;
	let finishOldRequest: ((response: Response) => void) | undefined;
	let fetchCount = 0;
	globalThis.fetch = async () => {
		fetchCount += 1;
		if (fetchCount === 1) {
			return new Promise<Response>((resolve) => {
				finishOldRequest = resolve;
			});
		}
		return commentResponse("正しい区間のコメント");
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const source = createSource();
	const manager = new KakologManager();
	manager.setSources([{ ...source, endAt: source.startAt + 5 }]);
	const oldFetch = manager.fetchWithLimit(5);
	assert.ok(finishOldRequest);
	manager.setSources([source]);
	const comments = await manager.fetchWithLimit(1800);
	finishOldRequest(commentResponse("古い区間のコメント"));
	assert.deepEqual(await oldFetch, []);
	assert.equal(fetchCount, 2);
	assert.equal(comments[0]?.content, "正しい区間のコメント");
	assert.deepEqual(manager.getAllComments(), comments);
	assert.equal(manager.isFullyCompleted(), true);
});

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
	assert.equal(manager.hasPendingInitialSourceFetch(), false);

	now = minuteStart + 65;
	assert.equal(manager.hasPendingInitialSourceFetch(), true);
	const comments = await manager.fetchWithLimit(5);

	assert.equal(fetchCount, 1);
	assert.equal(comments.length, 1);
	assert.equal(comments[0]?.content, "開始直後のコメント");
	assert.equal(manager.isFullyCompleted(), true);
	assert.equal(manager.hasPendingInitialSourceFetch(), false);
});

test("retries a chunk whose end was clipped to the current minute", async (t) => {
	const originalNow = Date.now;
	const originalFetch = globalThis.fetch;
	const minuteStart = 1_700_000_040;
	let now = minuteStart + 45;
	const requestedUrls: URL[] = [];

	Date.now = () => now * 1000;
	globalThis.fetch = async (input) => {
		requestedUrls.push(new URL(String(input)));
		const chats = [
			{
				chat: {
					id: "1",
					no: "1",
					vpos: "0",
					content: "確定済みのコメント",
					date: String(minuteStart - 10),
					date_usec: "0",
					mail: "",
					user_id: "user-1",
				},
			},
		];
		if (requestedUrls.length > 1) {
			chats.push({
				chat: {
					id: "2",
					no: "2",
					vpos: "0",
					content: "後から確定したコメント",
					date: String(minuteStart + 20),
					date_usec: "0",
					mail: "",
					user_id: "user-2",
				},
			});
		}
		return new Response(JSON.stringify({ packet: chats }), { status: 200 });
	};
	t.after(() => {
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
	});

	const source: ResolvedCommentSource = {
		key: `primary:jk1:na:${minuteStart - 20}`,
		kind: "primary",
		jkId: "jk1",
		channelName: "Primary",
		startAt: minuteStart - 20,
		endAt: minuteStart + 40,
		programStartAt: minuteStart - 20,
	};
	const manager = new KakologManager();
	manager.setSources([source]);

	const partialComments = await manager.fetchWithLimit(60);
	assert.equal(partialComments.length, 1);
	assert.equal(requestedUrls.length, 1);
	assert.equal(
		requestedUrls[0]?.searchParams.get("endtime"),
		String(minuteStart),
	);
	assert.equal(manager.isFullyCompleted(), false);
	assert.equal(manager.hasPendingInitialSourceFetch(), false);

	await manager.fetchWithLimit(60);
	assert.equal(requestedUrls.length, 1, "分境界までは同じ区間を再取得しない");

	now = minuteStart + 65;
	assert.equal(manager.hasPendingInitialSourceFetch(), true);
	const completedComments = await manager.fetchWithLimit(60);

	assert.equal(requestedUrls.length, 2);
	assert.equal(
		requestedUrls[1]?.searchParams.get("endtime"),
		String(minuteStart + 40),
	);
	assert.deepEqual(
		completedComments.map((comment) => comment.content),
		["確定済みのコメント", "後から確定したコメント"],
	);
	assert.equal(manager.isFullyCompleted(), true);
});

test("retries failed published prefix immediately without waiting for the next minute", async (t) => {
	const originalNow = Date.now;
	const originalFetch = globalThis.fetch;
	const minuteStart = 1_700_000_040;
	Date.now = () => (minuteStart + 30) * 1000;
	let attempts = 0;
	globalThis.fetch = async () => {
		attempts += 1;
		return attempts === 1
			? Response.json({ error: "temporary failure" })
			: commentResponse("再試行成功");
	};
	t.after(() => {
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
	});
	const source = {
		...createSource(),
		startAt: minuteStart - 120,
		endAt: minuteStart + 120,
	};
	const manager = new KakologManager();
	manager.setSources([source]);
	await manager.fetchWithLimit(240);
	assert.equal(manager.hasPendingInitialSourceFetch(), true);
	assert.equal(manager.isUnfetchedAt(0), true);
	await manager.fetchWithLimit(240);
	assert.equal(attempts, 2);
	assert.equal(manager.hasPendingInitialSourceFetch(), false);
});

test("fetches only newly published suffixes and resets progress when cache is cleared", async (t) => {
	const originalNow = Date.now;
	const originalFetch = globalThis.fetch;
	const minuteStart = 1_700_000_040;
	let now = minuteStart + 30;
	const ranges: number[][] = [];
	Date.now = () => now * 1000;
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		ranges.push([
			Number(url.searchParams.get("starttime")),
			Number(url.searchParams.get("endtime")),
		]);
		return commentResponse("重複しないコメント");
	};
	t.after(() => {
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
	});
	const source = {
		...createSource(),
		startAt: minuteStart - 120,
		endAt: minuteStart + 120,
	};
	const manager = new KakologManager();
	manager.setSources([source]);
	await manager.fetchWithLimit(240);
	now += 60;
	await manager.fetchWithLimit(240);
	now += 60;
	const comments = await manager.fetchWithLimit(240);
	assert.deepEqual(ranges, [
		[minuteStart - 120, minuteStart],
		[minuteStart, minuteStart + 60],
		[minuteStart + 60, minuteStart + 120],
	]);
	assert.equal(comments.length, 1);
	assert.equal(manager.isFullyCompleted(), true);
	manager.clearCache();
	await manager.fetchWithLimit(240);
	assert.deepEqual(ranges.at(-1), [minuteStart - 120, minuteStart + 120]);
});

for (const failingBackend of ["niconico", "miyou"] satisfies Array<
	"niconico" | "miyou"
>) {
	test(`retries only failed ${failingBackend} prefix while preserving the other backend progress`, async (t) => {
		const originalFetch = globalThis.fetch;
		const originalNow = Date.now;
		const originalSettings = getSettings();
		const originalWindow = Object.getOwnPropertyDescriptor(
			globalThis,
			"window",
		);
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: new EventTarget(),
		});
		const minuteStart = 1_700_000_040;
		let now = minuteStart + 30;
		Date.now = () => now * 1000;
		saveSettings({
			...originalSettings,
			miyouEnabled: true,
			miyouEmail: "test@example.com",
			miyouPassword: "test",
		});
		clearMiyouAuth();
		const ranges = { niconico: [] as number[][], miyou: [] as number[][] };
		globalThis.fetch = async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/auth/moritapo"))
				return Response.json({ token: "test-token" });
			const backend =
				url.hostname === "jikkyo.tsukumijima.net" ? "niconico" : "miyou";
			ranges[backend].push(
				backend === "niconico"
					? [
							Number(url.searchParams.get("starttime")),
							Number(url.searchParams.get("endtime")),
						]
					: [
							Number(url.searchParams.get("start")) / 1000,
							Number(url.searchParams.get("end")) / 1000,
						],
			);
			if (backend === failingBackend && ranges[backend].length === 1) {
				if (backend === "niconico")
					return Response.json({ error: "temporary failure" });
				throw new Error("temporary failure");
			}
			return backend === "niconico"
				? commentResponse("ニコニコ")
				: Response.json({ data: { comments: [] } });
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
			Date.now = originalNow;
			saveSettings(originalSettings);
			clearMiyouAuth();
			if (originalWindow)
				Object.defineProperty(globalThis, "window", originalWindow);
			else Reflect.deleteProperty(globalThis, "window");
		});
		const source = {
			...createSource(),
			startAt: minuteStart - 120,
			endAt: minuteStart + 120,
			miyouChannel: "livebs2",
		};
		const manager = new KakologManager();
		manager.setSources([source]);
		await manager.fetchWithLimit(240);
		assert.equal(manager.hasPendingInitialSourceFetch(), true);
		await manager.fetchWithLimit(240);
		const successfulBackend =
			failingBackend === "niconico" ? "miyou" : "niconico";
		assert.equal(ranges[successfulBackend].length, 1);
		assert.equal(ranges[failingBackend].length, 2);
		assert.equal(manager.hasPendingInitialSourceFetch(), false);
		now += 60;
		await manager.fetchWithLimit(240);
		assert.deepEqual(ranges.niconico.at(-1), [minuteStart, minuteStart + 60]);
		assert.deepEqual(ranges.miyou.at(-1), [minuteStart, minuteStart + 60]);
		await manager.refreshMiyou(240);
		assert.deepEqual(ranges.miyou.at(-1), [
			minuteStart - 120,
			minuteStart + 60,
		]);
		now += 60;
		await manager.fetchWithLimit(240);
		assert.deepEqual(ranges.miyou.at(-1), [
			minuteStart + 60,
			minuteStart + 120,
		]);
		assert.equal(manager.isFullyCompleted(), true);
	});
}
