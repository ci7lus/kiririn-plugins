import assert from "node:assert/strict";
import test from "node:test";

import { createCallbackRelay } from "../src/plugins/nicojk/callback-relay";

test("callback relay stops invoking and releases its owner callback on dispose", () => {
	let received = 0;
	const relay = createCallbackRelay((value: number) => {
		received += value;
	});

	relay.listener(3);
	relay.dispose();
	relay.listener(5);
	relay.dispose();

	assert.equal(received, 3);
});
