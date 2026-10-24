type CallbackSlot<TArgs extends unknown[]> = {
	callback: ((...args: TArgs) => void) | null;
};

function invokeCallback<TArgs extends unknown[]>(
	slot: CallbackSlot<TArgs>,
	...args: TArgs
) {
	slot.callback?.(...args);
}

/**
 * Keeps the long-lived bridge callback independent from the callback's owner.
 * Disposing the relay releases closures captured by the React effect.
 */
export function createCallbackRelay<TArgs extends unknown[]>(
	callback: (...args: TArgs) => void,
) {
	const slot: CallbackSlot<TArgs> = { callback };
	return {
		listener: (...args: TArgs) => invokeCallback(slot, ...args),
		dispose: () => {
			slot.callback = null;
		},
	};
}
