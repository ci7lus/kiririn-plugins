import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeCommentSourcesByChapters } from "../src/plugins/nicojk/chapter-source-sync";
import type { NiconicoComment } from "../src/plugins/nicojk/comment-client";
import { KakologManager } from "../src/plugins/nicojk/kakolog-manager";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

const START_AT = 1_700_000_000;
const SYNC_OPTIONS = {
	windowSeconds: 10,
	cooldownSeconds: 60,
	minimumCount: 3,
};

const SOURCES: ResolvedCommentSource[] = [
	{
		key: "primary",
		kind: "primary",
		jkId: "jk1",
		channelName: "Primary",
		startAt: START_AT,
		endAt: START_AT + 1800,
	},
	{
		key: "replay",
		kind: "replay",
		jkId: "jk2",
		channelName: "Replay",
		startAt: START_AT + 86400,
		endAt: START_AT + 86400 + 1800,
	},
];

let nextId = 1;

function comment(
	sourceOrdinal: number,
	relativeSec: number,
	content: string,
): NiconicoComment {
	return {
		id: nextId++,
		no: nextId,
		vpos: Math.round((START_AT + relativeSec) * 100),
		content,
		date: START_AT + relativeSec,
		date_usec: 0,
		mail: [],
		user_id: "",
		premium: 0,
		anonymity: 0,
		sourceOrdinal,
	};
}

function chapter(
	sourceOrdinal: number,
	relativeSec: number,
	label: string,
): NiconicoComment[] {
	return [
		comment(sourceOrdinal, relativeSec, label),
		comment(sourceOrdinal, relativeSec + 1, label),
		comment(sourceOrdinal, relativeSec + 2, label),
	];
}

test("Primary の複数チャプター位置を基準に 3 分遅いソースを補正する", () => {
	const secondaryBody = comment(1, 600, "本編コメント");
	const comments = [
		...chapter(0, 300, "OP"),
		...chapter(0, 900, "B"),
		...chapter(1, 480, "OP"),
		...chapter(1, 1080, "B"),
		secondaryBody,
	];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, [
		{
			sourceOrdinal: 1,
			offsetSeconds: -180,
			matchedLabels: ["B", "OP"],
		},
	]);
	assert.equal(
		synchronized.comments.find((item) => item.id === secondaryBody.id)?.vpos,
		secondaryBody.vpos - 18000,
	);
	assert.equal(synchronized.comments[0], comments[0]);
});

test("Primary にチャプターが無ければ他ソースを補正しない", () => {
	const comments = [comment(0, 300, "通常コメント"), ...chapter(1, 480, "OP")];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, []);
	assert.equal(synchronized.comments, comments);
});

test("複数チャプターの差分が一致しない場合は補正しない", () => {
	const comments = [
		...chapter(0, 300, "OP"),
		...chapter(0, 900, "ED"),
		...chapter(1, 480, "OP"),
		...chapter(1, 900, "ED"),
	];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, []);
	assert.equal(synchronized.comments, comments);
});

test("単独の OP は補正に使うが、反応速度程度の差は無視する", () => {
	const delayed = synchronizeCommentSourcesByChapters(
		[...chapter(0, 300, "OP"), ...chapter(1, 480, "OP")],
		SOURCES,
		SYNC_OPTIONS,
	);
	assert.equal(delayed.corrections[0]?.offsetSeconds, -180);

	const nearbyComments = [...chapter(0, 300, "OP"), ...chapter(1, 307, "OP")];
	const nearby = synchronizeCommentSourcesByChapters(
		nearbyComments,
		SOURCES,
		SYNC_OPTIONS,
	);
	assert.deepEqual(nearby.corrections, []);
	assert.equal(nearby.comments, nearbyComments);
});

test("単独の「ここ」は誤補正を避けるため同期基準にしない", () => {
	const comments = [...chapter(0, 300, "ここ"), ...chapter(1, 480, "ここ")];

	const synchronized = synchronizeCommentSourcesByChapters(
		comments,
		SOURCES,
		SYNC_OPTIONS,
	);

	assert.deepEqual(synchronized.corrections, []);
});

test("無効化したソースは補正状態を残したまま vpos へ適用しない", () => {
	const primaryChapter = chapter(0, 300, "OP");
	const secondaryBody = comment(1, 600, "本編コメント");
	const comments = [...primaryChapter, ...chapter(1, 480, "OP"), secondaryBody];

	const synchronized = synchronizeCommentSourcesByChapters(comments, SOURCES, {
		...SYNC_OPTIONS,
		disabledSourceOrdinals: new Set([1]),
	});

	assert.deepEqual(synchronized.corrections, [
		{
			sourceOrdinal: 1,
			offsetSeconds: -180,
			matchedLabels: ["OP"],
		},
	]);
	assert.equal(
		synchronized.comments.find((item) => item.id === secondaryBody.id)?.vpos,
		secondaryBody.vpos,
	);
	assert.deepEqual(
		synchronized.comments
			.filter((item) => item.sourceOrdinal === 0)
			.map((item) => item.vpos),
		primaryChapter.map((item) => item.vpos),
	);
});

test("キャッシュをクリアするとソースの補正無効化もリセットする", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		const isPrimary = url.pathname.endsWith("/jk1");
		const sourceStartAt = isPrimary ? START_AT : START_AT + 86400;
		const relativeChapterAt = isPrimary ? 300 : 480;
		const chats = chapterApiComments(sourceStartAt, relativeChapterAt, "OP");
		if (!isPrimary) {
			chats.push(apiComment(sourceStartAt, 600, "本編コメント", 4));
		}
		return Response.json({
			packet: chats.map((chat) => ({ chat })),
		});
	};

	try {
		const manager = new KakologManager();
		manager.setSources(SOURCES);

		const corrected = await manager.fetchWithLimit(1800);
		const correctedBody = corrected.find(
			(item) => item.content === "本編コメント",
		);
		assert.equal(correctedBody?.vpos, (START_AT + 420) * 100);

		const disabled = manager.setChapterCorrectionEnabled("replay", false);
		const disabledBody = disabled.find(
			(item) => item.content === "本編コメント",
		);
		assert.equal(disabledBody?.vpos, (START_AT + 600) * 100);

		manager.clearCache();
		const correctedAfterReset = await manager.fetchWithLimit(1800);
		const resetBody = correctedAfterReset.find(
			(item) => item.content === "本編コメント",
		);
		assert.equal(resetBody?.vpos, (START_AT + 420) * 100);
		assert.equal(manager.getChapterCorrections()[0]?.enabled, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("取得後に追加されたソースも次の取得で読み込む", async () => {
	const originalFetch = globalThis.fetch;
	const requestedJkIds: string[] = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		const jkId = url.pathname.split("/").pop() || "";
		requestedJkIds.push(jkId);
		const sourceStartAt = jkId === "jk1" ? START_AT : START_AT + 86400;
		return Response.json({
			packet: [
				{
					chat: apiComment(sourceStartAt, 30, jkId, 1),
				},
			],
		});
	};

	try {
		const manager = new KakologManager();
		manager.setSources([SOURCES[0]]);

		const primaryComments = await manager.fetchWithLimit(1800);
		assert.equal(primaryComments.length, 1);

		manager.setSources(SOURCES);
		assert.equal(manager.hasPendingInitialSourceFetch(), true);

		const allComments = await manager.fetchWithLimit(1800);
		assert.equal(allComments.length, 2);
		assert.equal(
			allComments.find((item) => item.sourceOrdinal === 1)?.content,
			"jk2",
		);
		assert.equal(manager.hasPendingInitialSourceFetch(), false);
		assert.deepEqual(requestedJkIds, ["jk1", "jk2"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function chapterApiComments(
	sourceStartAt: number,
	relativeSec: number,
	label: string,
) {
	return [
		apiComment(sourceStartAt, relativeSec, label, 1),
		apiComment(sourceStartAt, relativeSec + 1, label, 2),
		apiComment(sourceStartAt, relativeSec + 2, label, 3),
	];
}

function apiComment(
	sourceStartAt: number,
	relativeSec: number,
	content: string,
	no: number,
) {
	return {
		id: String(no),
		no: String(no),
		vpos: "0",
		content,
		date: String(sourceStartAt + relativeSec),
		date_usec: "0",
		mail: "",
		user_id: `user-${no}`,
	};
}
