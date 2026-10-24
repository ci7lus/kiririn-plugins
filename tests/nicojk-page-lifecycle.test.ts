import assert from "node:assert/strict";
import test from "node:test";

import { startPageLifecycle } from "../src/plugins/nicojk/page-lifecycle";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("page lifecycle cancels late mounts and restores after pageshow", async () => {
	const target = new EventTarget();
	const pending = [deferred<void>(), deferred<void>()];
	let initializeCount = 0;
	let mountCount = 0;
	let unmountCount = 0;
	let disposeCount = 0;

	const stop = startPageLifecycle(
		target as Window,
		() => pending[initializeCount++].promise,
		() => mountCount++,
		() => unmountCount++,
		() => disposeCount++,
	);

	target.dispatchEvent(new Event("pagehide"));
	target.dispatchEvent(new Event("pagehide"));
	target.dispatchEvent(new Event("pageshow"));
	pending[0].resolve();
	await Promise.resolve();
	assert.equal(
		mountCount,
		0,
		"the pre-pagehide initialization must stay cancelled",
	);
	pending[1].resolve();
	await Promise.resolve();
	assert.equal(mountCount, 1);

	target.dispatchEvent(new Event("pagehide"));
	assert.equal(unmountCount, 2);
	assert.equal(disposeCount, 2);
	stop();
	assert.equal(unmountCount, 2, "stopping after pagehide must be idempotent");
});

test("page lifecycle mounts after initialization only once", async () => {
	const target = new EventTarget();
	let mountCount = 0;
	const stop = startPageLifecycle(
		target as Window,
		async () => undefined,
		() => mountCount++,
		() => {},
		() => {},
	);
	await Promise.resolve();
	target.dispatchEvent(new Event("pageshow"));
	await Promise.resolve();
	assert.equal(mountCount, 1);
	stop();
});
