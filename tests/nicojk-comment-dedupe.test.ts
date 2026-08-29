import assert from "node:assert/strict";
import test from "node:test";
import type { NiconicoComment } from "../src/plugins/nicojk/comment-client";
import {
	createRecordedNGTraceState,
	isCommentNGBySettings,
	markLiveDuplicateComments,
	markRecordedDuplicateComments,
	traceRecordedNGCommentsIfCountChanged,
} from "../src/plugins/nicojk/comment-dedupe";

function comment(
	user_id: string,
	content: string,
	options: Partial<NiconicoComment> = {},
): NiconicoComment {
	return {
		id: options.id || 1,
		no: options.no || 1,
		vpos: options.vpos || 1,
		content,
		date: options.date || 1,
		date_usec: options.date_usec || 0,
		mail: [],
		user_id,
		premium: 0,
		anonymity: 0,
		...options,
	};
}

function countTraces(action: () => void) {
	const originalTrace = console.trace;
	let count = 0;
	console.trace = (..._args: Parameters<typeof console.trace>) => {
		count += 1;
	};
	try {
		action();
	} finally {
		console.trace = originalTrace;
	}
	return count;
}

test("ライブコメントは10分以内の同じID・本文だけ自動NGになる", () => {
	const comments = markLiveDuplicateComments([
		comment("user-a", "w"),
		comment("user-a", "w", { id: 2 }),
		comment("user-a", "別", { id: 3 }),
		comment("user-b", "w", { id: 4 }),
	]);

	assert.deepEqual(
		comments.map((item) => item.isDuplicate),
		[false, true, false, false],
	);
});

test("重複判定は直前の同一コメントから10分以内に限る", () => {
	const comments = markLiveDuplicateComments([
		comment("user-a", "same", { id: 1, date: 1_000 }),
		comment("user-a", "same", { id: 2, date: 1_600 }),
		comment("user-a", "same", { id: 3, date: 2_201 }),
		comment("user-a", "same", { id: 4, date: 2_801 }),
	]);

	assert.deepEqual(
		comments.map((item) => item.isDuplicate),
		[false, true, false, true],
	);
});

test("過去ログの重複判定も同一ソース内の10分以内に限る", () => {
	const comments = markRecordedDuplicateComments([
		comment("user-a", "同じ本文", {
			id: 1,
			date: 1_000,
			sourceOrdinal: 0,
		}),
		comment("user-a", "同じ本文", {
			id: 2,
			date: 1_600,
			sourceOrdinal: 0,
		}),
		comment("user-a", "同じ本文", {
			id: 3,
			date: 2_201,
			sourceOrdinal: 0,
		}),
		comment("user-a", "同じ本文", {
			id: 4,
			date: 2_801,
			sourceOrdinal: 0,
		}),
	]);

	assert.deepEqual(
		comments.map((item) => item.isDuplicate),
		[false, true, false, true],
	);
});

test("過去ログは同一ソース・同一ID・4文字以上の本文だけ重複を自動NGにする", () => {
	const comments = markRecordedDuplicateComments([
		comment("user-a", "同じ本文", { id: 1, sourceOrdinal: 0 }),
		comment("user-a", "同じ本文", { id: 2, sourceOrdinal: 0 }),
		comment("user-a", "同じ本文", { id: 3, sourceOrdinal: 1 }),
		comment("user-a", "短い", { id: 4, sourceOrdinal: 0 }),
		comment("user-b", "同じ本文", { id: 5, sourceOrdinal: 0 }),
	]);

	assert.deepEqual(
		comments.map((item) => item.isDuplicate),
		[false, true, false, false, false],
	);
});

test("重複判定を再計算すると先頭コメントだけが残る", () => {
	const first = comment("user-a", "same", { id: 1 });
	const duplicate = comment("user-a", "same", { id: 2 });
	const marked = markLiveDuplicateComments([first, duplicate]);
	const recalculated = markLiveDuplicateComments([duplicate, first]);

	assert.equal(marked[1]?.isDuplicate, true);
	assert.equal(recalculated[0]?.isDuplicate, false);
	assert.equal(recalculated[1]?.isDuplicate, true);
});

test("自動NGを無効にすると重複コメントを表示対象へ戻せる", () => {
	const duplicate = { ...comment("user-a", "same"), isDuplicate: true };
	const settings = {
		deduplicateComments: true,
		ngIds: [],
		ngWords: [],
	};

	assert.equal(isCommentNGBySettings(duplicate, settings), true);
	assert.equal(
		isCommentNGBySettings(duplicate, {
			...settings,
			deduplicateComments: false,
		}),
		false,
	);
});

test("ライブコメントのNG判定ではtraceを出さない", () => {
	const liveComment = {
		...comment("user-a", "same", { origin: "ws" }),
		isDuplicate: true,
	};
	const settings = {
		deduplicateComments: true,
		ngIds: [],
		ngWords: [],
	};

	assert.equal(
		countTraces(() => {
			assert.equal(isCommentNGBySettings(liveComment, settings), true);
		}),
		0,
	);
});

test("過去ログのNG traceはコメント数が変動したときだけ出す", () => {
	const settings = {
		deduplicateComments: true,
		ngIds: [],
		ngWords: [],
	};
	const state = createRecordedNGTraceState();
	const first = {
		...comment("user-a", "同じ本文", { sourceOrdinal: 0 }),
		isDuplicate: true,
	};

	assert.equal(
		countTraces(() => {
			assert.equal(
				traceRecordedNGCommentsIfCountChanged(
					[first],
					settings,
					state,
					"player-a",
				),
				true,
			);
		}),
		1,
	);
	assert.equal(
		countTraces(() => {
			assert.equal(
				traceRecordedNGCommentsIfCountChanged(
					[first],
					settings,
					state,
					"player-a",
				),
				false,
			);
		}),
		0,
	);

	const second = {
		...comment("user-b", "別の本文", { id: 2, sourceOrdinal: 0 }),
		isDuplicate: true,
	};
	assert.equal(
		countTraces(() => {
			assert.equal(
				traceRecordedNGCommentsIfCountChanged(
					[first, second],
					settings,
					state,
					"player-a",
				),
				true,
			);
		}),
		1,
	);
	assert.equal(
		countTraces(() => {
			assert.equal(
				traceRecordedNGCommentsIfCountChanged(
					[first, second],
					settings,
					state,
					"player-a",
				),
				false,
			);
		}),
		0,
	);
});

test("過去ログの不正なcontentでも重複判定が例外にならない", () => {
	const invalidComments = [
		comment("user-a", "placeholder", {
			content: null as unknown as string,
			sourceOrdinal: 0,
		}),
		comment("user-a", "placeholder", {
			content: undefined as unknown as string,
			sourceOrdinal: 0,
		}),
	] as NiconicoComment[];

	assert.doesNotThrow(() => {
		const marked = markRecordedDuplicateComments(invalidComments);
		assert.deepEqual(
			marked.map((item) => item.isDuplicate),
			[false, false],
		);
	});
});
