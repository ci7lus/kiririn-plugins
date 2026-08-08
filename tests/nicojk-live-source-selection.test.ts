import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPrimarySource,
	createLiveCommentClient,
	getLiveClientKey,
} from "../src/plugins/nicojk/App";
import { CommentClient } from "../src/plugins/nicojk/comment-client";
import type { NicoJKChannelDefinition } from "../src/plugins/nicojk/definitions";
import { NiconicoCommentClient } from "../src/plugins/nicojk/niconico-comment-client";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

function source(key: string): ResolvedCommentSource {
	return {
		key,
		kind: "primary",
		jkId: "jk1",
		channelName: "Test",
		startAt: 1,
		endAt: 2,
	};
}

test("live client keys include mode and source key", () => {
	const resolved = source("primary:jk1:na:1");

	assert.equal(
		getLiveClientKey("niconico", resolved),
		"niconico:primary:jk1:na:1",
	);
	assert.notEqual(
		getLiveClientKey("niconico", resolved),
		getLiveClientKey("nx-jikkyo", resolved),
	);
});

test("live client factory selects the configured transport", () => {
	assert.ok(
		createLiveCommentClient("niconico") instanceof NiconicoCommentClient,
	);
	assert.ok(createLiveCommentClient("nx-jikkyo") instanceof CommentClient);
});

test("CommentClient source connections use source.key for coordination IDs", async () => {
	const originalBroadcastChannel = globalThis.BroadcastChannel;
	const originalLocks = globalThis.navigator?.locks;
	const resolved = source("primary:jk1:na:1");
	const broadcastNames: string[] = [];
	const lockKeys: string[] = [];

	class RecordingBroadcastChannel {
		onmessage: ((event: MessageEvent) => void) | null = null;

		constructor(name: string) {
			broadcastNames.push(name);
		}

		postMessage(_data: unknown) {}
		close() {}
	}

	const locks = {
		request(
			name: string,
			optionsOrCallback:
				| { ifAvailable: boolean }
				| ((lock: unknown) => unknown),
			callback?: (lock: unknown) => unknown,
		) {
			lockKeys.push(name);
			const handler =
				typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
			return Promise.resolve(handler?.(null));
		},
	};

	(
		globalThis as typeof globalThis & {
			BroadcastChannel: typeof RecordingBroadcastChannel;
		}
	).BroadcastChannel = RecordingBroadcastChannel as never;
	if (globalThis.navigator) {
		Object.defineProperty(globalThis.navigator, "locks", {
			configurable: true,
			value: locks,
		});
	}

	const client = new CommentClient();
	try {
		client.connect(resolved);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(broadcastNames, [`nicojk_comments_${resolved.key}`]);
		assert.deepEqual(lockKeys, [
			`nicojk_lock_${resolved.key}`,
			`nicojk_lock_${resolved.key}`,
		]);
	} finally {
		client.disconnect();
		(
			globalThis as typeof globalThis & {
				BroadcastChannel: typeof BroadcastChannel;
			}
		).BroadcastChannel = originalBroadcastChannel;
		if (globalThis.navigator) {
			Object.defineProperty(globalThis.navigator, "locks", {
				configurable: true,
				value: originalLocks,
			});
		}
	}
});

test("Niconico and nx-jikkyo clients report connected in passive mode", () => {
	const resolved = {
		...source("primary:jk1:na:1"),
		nicoliveCommunityId: "co1",
	};
	const niconicoClient = createLiveCommentClient("niconico");
	const jikkyoClient = createLiveCommentClient("nx-jikkyo");

	try {
		niconicoClient.connect(resolved, { passive: true });
		jikkyoClient.connect(resolved, { passive: true });
		assert.equal(niconicoClient.getStatus(), "connected");
		assert.equal(jikkyoClient.getStatus(), "connected");
	} finally {
		niconicoClient.disconnect();
		jikkyoClient.disconnect();
	}
});

test("fallback primary source carries NicoNico metadata before resolution", () => {
	const fallback = buildPrimarySource(
		{
			jkId: "jk1",
			name: "Test",
			type: "terrestrial",
			serviceIds: [1],
			networkId: 1,
			nicoliveCommunityIds: ["co123"],
		} satisfies NicoJKChannelDefinition,
		1,
		1,
		2,
	);

	assert.ok(fallback);
	assert.equal(fallback.nicoliveCommunityId, "co123");
	assert.equal(
		getLiveClientKey("niconico", fallback),
		getLiveClientKey("niconico", {
			...fallback,
			nicoliveCommunityId: "co123",
		}),
	);
});
