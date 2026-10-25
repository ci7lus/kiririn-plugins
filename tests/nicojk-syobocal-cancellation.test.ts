import assert from "node:assert/strict";
import test from "node:test";
import {
	lookupChannelProgramAt,
	lookupProgramsByTitleAt,
	lookupProgramsByTitleBetween,
} from "../src/plugins/nicojk/syobocal";

for (const kind of ["channel", "live", "replay"] as const) {
	test(`${kind} lookup aborts in-flight fetch without blocking another consumer`, async (t) => {
		const originalFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = originalFetch;
		});
		const signals: AbortSignal[] = [];
		globalThis.fetch = async (_input, init) => {
			assert.ok(init?.signal, "lookup must forward its abort signal to fetch");
			const signal = init.signal;
			signals.push(signal);
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		};
		const lookup = (signal: AbortSignal) =>
			kind === "channel"
				? lookupChannelProgramAt(333, 1700000000, signal)
				: kind === "live"
					? lookupProgramsByTitleAt(333, 1700000000, 1, signal)
					: lookupProgramsByTitleBetween(
							333,
							1600000000,
							1700000000,
							1,
							signal,
						);
		const first = new AbortController();
		const second = new AbortController();
		const firstPending = lookup(first.signal);
		const secondPending = lookup(second.signal);
		assert.equal(signals.length, 2);
		first.abort();
		await assert.rejects(firstPending, { name: "AbortError" });
		assert.equal(second.signal.aborted, false);
		second.abort();
		await assert.rejects(secondPending, { name: "AbortError" });
		const retry = new AbortController();
		const retried = lookup(retry.signal);
		assert.equal(signals.length, 3, "aborted requests must not remain cached");
		retry.abort();
		await assert.rejects(retried, { name: "AbortError" });
	});
}
