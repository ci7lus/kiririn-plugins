import assert from "node:assert/strict";
import test from "node:test";

import {
	disposeSettingsSubscription,
	getSettings,
	initializeSettings,
} from "../src/plugins/nicojk/ng-settings";

test("settings subscription is removed on dispose and reattached on restore", async () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const originalBrowser = Object.getOwnPropertyDescriptor(
		globalThis,
		"browser",
	);
	const listeners = new Set<(...args: unknown[]) => void>();
	const reads: Array<{
		resolve: (value: Record<string, unknown>) => void;
	}> = [];
	let adds = 0;
	let removes = 0;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: new EventTarget(),
	});
	Object.defineProperty(globalThis, "browser", {
		configurable: true,
		value: {
			storage: {
				local: {
					get: () =>
						new Promise<Record<string, unknown>>((resolve) => {
							reads.push({ resolve });
						}),
				},
				onChanged: {
					addListener: (listener: (...args: unknown[]) => void) => {
						adds += 1;
						listeners.add(listener);
					},
					removeListener: (listener: (...args: unknown[]) => void) => {
						removes += 1;
						listeners.delete(listener);
					},
				},
			},
		},
	});

	try {
		const staleInitialization = initializeSettings();
		assert.equal(adds, 1);
		assert.equal(listeners.size, 1);

		disposeSettingsSubscription();
		assert.equal(removes, 1);
		assert.equal(listeners.size, 0);

		getSettings();
		assert.equal(adds, 1, "late reads while disposed must not resubscribe");

		const restoredInitialization = initializeSettings();
		assert.equal(adds, 2);
		assert.equal(listeners.size, 1);
		reads[1]?.resolve({ nicojk_settings: { showComments: false } });
		await restoredInitialization;
		reads[0]?.resolve({ nicojk_settings: { showComments: true } });
		await staleInitialization;
		assert.equal(
			getSettings().showComments,
			false,
			"the stale pre-dispose read must not overwrite restored settings",
		);
	} finally {
		disposeSettingsSubscription();
		if (originalWindow) {
			Object.defineProperty(globalThis, "window", originalWindow);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
		if (originalBrowser) {
			Object.defineProperty(globalThis, "browser", originalBrowser);
		} else {
			Reflect.deleteProperty(globalThis, "browser");
		}
	}
});
