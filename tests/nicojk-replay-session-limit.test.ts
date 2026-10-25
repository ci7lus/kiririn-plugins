import assert from "node:assert/strict";
import test from "node:test";
import type { NicoJKChannelDefinition } from "../src/plugins/nicojk/definitions";
import {
	resolveCommentSources,
	selectRecordedReplaySources,
} from "../src/plugins/nicojk/source-resolver";
import type { SyobocalProgram } from "../src/plugins/nicojk/syobocal";

const channel: NicoJKChannelDefinition = {
	type: "GR",
	name: "Test",
	serviceIds: [],
	networkId: 1,
	jkId: "jk1",
	syobocalId: 1,
};
const base: SyobocalProgram = {
	pid: 1,
	tid: 1,
	chId: 1,
	count: 1,
	subTitle: "Episode",
	stSubTitle: "",
	progComment: "",
	startAt: 100,
	endAt: 1900,
	rawStartAt: "",
	rawEndAt: "",
};

test("session limit counts unique supported additional sessions newest first", () => {
	const newest = { ...base, pid: 2, startAt: 400, endAt: 2200 };
	const older = { ...base, pid: 3, startAt: 200, endAt: 2000 };
	const unsupported = { ...base, pid: 4, chId: 999, startAt: 600, endAt: 2400 };
	const candidates = [older, base, newest, newest, unsupported];
	const index = new Map([[1, channel]]);
	assert.deepEqual(
		selectRecordedReplaySources(candidates, base, index, 1).map(
			(s) => s.startAt,
		),
		[400],
	);
	assert.deepEqual(
		selectRecordedReplaySources(candidates, base, index, 10).map(
			(s) => s.startAt,
		),
		[400, 200],
	);
	assert.deepEqual(selectRecordedReplaySources(candidates, base, index, 0), []);
});

test("disabled Syobocal returns primary without network access", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("unexpected network request");
	};
	try {
		const result = await resolveCommentSources({
			primaryChannel: channel,
			baseStartAt: 100,
			duration: 1800,
			isLive: false,
			queryTime: 101,
			syobocalEnabled: false,
			replaySessionLimit: 10,
		});
		assert.equal(result.primary.startAt, 100);
		assert.equal(result.primary.programStartAt, undefined);
		assert.deepEqual(result.replaySources, []);
		assert.deepEqual(result.liveSources, []);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("cancelled resolution does not start subsequent Syobocal requests", async () => {
	const controller = new AbortController();
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		throw new Error("unexpected network request");
	};
	try {
		const pending = resolveCommentSources({
			primaryChannel: channel,
			baseStartAt: 100,
			duration: 1800,
			isLive: false,
			queryTime: 101,
			syobocalEnabled: true,
			replaySessionLimit: 10,
			signal: controller.signal,
		});
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		assert.equal(requests, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
