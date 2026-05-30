export type JsonStorageSource = "local";

type StorageChangeLike = {
	newValue?: unknown;
};

type BrowserStorageAreaLike = {
	get: (key: string) => Promise<Record<string, unknown>>;
	set: (items: Record<string, unknown>) => Promise<void>;
};

type BrowserStorageLike = {
	local?: BrowserStorageAreaLike;
	onChanged?: {
		addListener: (
			listener: (
				changes: Record<string, StorageChangeLike>,
				areaName: string,
			) => void,
		) => void;
		removeListener: (
			listener: (
				changes: Record<string, StorageChangeLike>,
				areaName: string,
			) => void,
		) => void;
	};
};

type StorageCandidate = {
	source: JsonStorageSource;
	area: BrowserStorageAreaLike | undefined;
};

export type StoredJsonResult<T> = {
	value: T | null;
	source: JsonStorageSource | null;
};

function getBrowserStorage(): BrowserStorageLike | undefined {
	return (
		globalThis as typeof globalThis & {
			browser?: {
				storage?: BrowserStorageLike;
			};
		}
	).browser?.storage;
}

function getStorageCandidates(): StorageCandidate[] {
	const storage = getBrowserStorage();
	return [{ source: "local", area: storage?.local }];
}

export async function readStoredJsonWithFallback<T>(
	key: string,
): Promise<StoredJsonResult<T>> {
	for (const candidate of getStorageCandidates()) {
		if (!candidate.area) {
			continue;
		}

		try {
			const stored = await candidate.area.get(key);
			if (key in stored && stored[key] !== undefined) {
				return {
					value: stored[key] as T,
					source: candidate.source,
				};
			}
		} catch (error) {
			console.warn(
				`Failed to read ${key} from browser.storage.${candidate.source}`,
				error,
			);
		}
	}

	return {
		value: null,
		source: null,
	};
}

export async function writeStoredJsonWithFallback(
	key: string,
	value: unknown,
): Promise<JsonStorageSource | null> {
	for (const candidate of getStorageCandidates()) {
		if (!candidate.area) {
			continue;
		}

		try {
			await candidate.area.set({ [key]: value });
			return candidate.source;
		} catch (error) {
			console.warn(
				`Failed to write ${key} to browser.storage.${candidate.source}`,
				error,
			);
		}
	}

	console.warn(`browser.storage.local is not available for ${key}`);
	return null;
}

export function subscribeStoredJsonChanges(
	key: string,
	onChange: (value: unknown) => void,
) {
	const cleanups: Array<() => void> = [];
	const storage = getBrowserStorage();

	if (storage?.onChanged) {
		const listener = (
			changes: Record<string, StorageChangeLike>,
			areaName: string,
		) => {
			if (areaName !== "local" || !(key in changes)) {
				return;
			}

			onChange(changes[key]?.newValue ?? null);
		};

		storage.onChanged.addListener(listener);
		cleanups.push(() => storage.onChanged?.removeListener(listener));
	}

	return () => {
		for (const cleanup of cleanups) {
			cleanup();
		}
	};
}
