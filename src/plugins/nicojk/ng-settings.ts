import {
	readStoredJsonWithFallback,
	subscribeStoredJsonChanges,
	writeStoredJsonWithFallback,
} from "./storage";

export const LIVE_COMMENT_SOURCE_VALUES = ["niconico", "nx-jikkyo"] as const;
export type LiveCommentSource = (typeof LIVE_COMMENT_SOURCE_VALUES)[number];

export function normalizeLiveCommentSource(value: unknown): LiveCommentSource {
	return value === "niconico" ? "niconico" : "nx-jikkyo";
}

export interface NicoJKSettings {
	ngWords: string[];
	ngIds: string[];
	ngCommands: string[];
	liveCommentSource: LiveCommentSource;
	syobocalEnabled: boolean;
	replaySessionLimit: number;
	showComments: boolean;
	opacity: number;
	secondarySourceOpacity: number;
	showResponseAnchorComments: boolean;
	deduplicateComments: boolean;
	chapterWindowSeconds: number;
	chapterCooldownSeconds: number;
	chapterMinimumCount: number;
	chapterSeekLeadSeconds: number;
	hideSecondarySourceComments: boolean;
	miyouEnabled: boolean;
	miyouEmail: string;
	miyouPassword: string;
}

export const STORAGE_KEY = "nicojk_settings";
export const SETTINGS_UPDATED_EVENT = "nicojk_settings_updated";

const DEFAULT_SETTINGS: NicoJKSettings = {
	ngWords: [],
	ngIds: [],
	ngCommands: [],
	liveCommentSource: "nx-jikkyo",
	syobocalEnabled: true,
	replaySessionLimit: 10,
	showComments: true,
	opacity: 0.8,
	secondarySourceOpacity: 1,
	showResponseAnchorComments: false,
	deduplicateComments: true,
	chapterWindowSeconds: 10,
	chapterCooldownSeconds: 60,
	chapterMinimumCount: 3,
	chapterSeekLeadSeconds: 5,
	hideSecondarySourceComments: false,
	miyouEnabled: false,
	miyouEmail: "",
	miyouPassword: "",
};

let settingsCache = DEFAULT_SETTINGS;
let settingsSignature = JSON.stringify(DEFAULT_SETTINGS);
let settingsInitialized = false;
let settingsInitialization: Promise<NicoJKSettings> | null = null;
let settingsSubscriptionAttached = false;
let settingsSubscriptionCleanup: (() => void) | null = null;
let settingsGeneration = 0;
let settingsSuspended = false;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function parseNumericValue(value: unknown) {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		return Number(value);
	}
	return Number.NaN;
}

function normalizeInteger(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
) {
	const parsed = parseNumericValue(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return clamp(Math.round(parsed), min, max);
}

function normalizeOpacity(value: unknown, fallback: number) {
	const parsed = parseNumericValue(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return clamp(parsed, 0, 1);
}

function normalizeStringArray(value: unknown) {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === "string");
}

export function normalizeSettings(value: unknown): NicoJKSettings {
	const stored =
		typeof value === "object" && value != null
			? (value as Partial<Record<keyof NicoJKSettings, unknown>>)
			: {};

	return {
		syobocalEnabled:
			typeof stored.syobocalEnabled === "boolean"
				? stored.syobocalEnabled
				: DEFAULT_SETTINGS.syobocalEnabled,
		replaySessionLimit: normalizeInteger(
			stored.replaySessionLimit,
			DEFAULT_SETTINGS.replaySessionLimit,
			0,
			Number.MAX_SAFE_INTEGER,
		),
		ngWords: normalizeStringArray(stored.ngWords),
		ngIds: normalizeStringArray(stored.ngIds),
		ngCommands: normalizeStringArray(stored.ngCommands),
		liveCommentSource: normalizeLiveCommentSource(stored.liveCommentSource),
		showComments:
			typeof stored.showComments === "boolean"
				? stored.showComments
				: DEFAULT_SETTINGS.showComments,
		opacity: normalizeOpacity(stored.opacity, DEFAULT_SETTINGS.opacity),
		secondarySourceOpacity: normalizeOpacity(
			stored.secondarySourceOpacity,
			DEFAULT_SETTINGS.secondarySourceOpacity,
		),
		showResponseAnchorComments:
			typeof stored.showResponseAnchorComments === "boolean"
				? stored.showResponseAnchorComments
				: DEFAULT_SETTINGS.showResponseAnchorComments,
		deduplicateComments:
			typeof stored.deduplicateComments === "boolean"
				? stored.deduplicateComments
				: DEFAULT_SETTINGS.deduplicateComments,
		chapterWindowSeconds: normalizeInteger(
			stored.chapterWindowSeconds,
			DEFAULT_SETTINGS.chapterWindowSeconds,
			1,
			120,
		),
		chapterCooldownSeconds: normalizeInteger(
			stored.chapterCooldownSeconds,
			DEFAULT_SETTINGS.chapterCooldownSeconds,
			0,
			1800,
		),
		chapterMinimumCount: normalizeInteger(
			stored.chapterMinimumCount,
			DEFAULT_SETTINGS.chapterMinimumCount,
			1,
			50,
		),
		chapterSeekLeadSeconds: normalizeInteger(
			stored.chapterSeekLeadSeconds,
			DEFAULT_SETTINGS.chapterSeekLeadSeconds,
			0,
			300,
		),
		hideSecondarySourceComments:
			typeof stored.hideSecondarySourceComments === "boolean"
				? stored.hideSecondarySourceComments
				: DEFAULT_SETTINGS.hideSecondarySourceComments,
		miyouEnabled:
			typeof stored.miyouEnabled === "boolean"
				? stored.miyouEnabled
				: DEFAULT_SETTINGS.miyouEnabled,
		miyouEmail:
			typeof stored.miyouEmail === "string"
				? stored.miyouEmail
				: DEFAULT_SETTINGS.miyouEmail,
		miyouPassword:
			typeof stored.miyouPassword === "string"
				? stored.miyouPassword
				: DEFAULT_SETTINGS.miyouPassword,
	};
}

function emitSettingsUpdated() {
	window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
}

function updateSettingsCache(value: unknown) {
	const normalized = normalizeSettings(value);
	const nextSignature = JSON.stringify(normalized);
	const didChange = nextSignature !== settingsSignature;

	settingsCache = normalized;
	settingsSignature = nextSignature;
	settingsInitialized = true;

	return didChange;
}

function ensureSettingsSubscription() {
	if (
		settingsSuspended ||
		settingsSubscriptionAttached ||
		typeof window === "undefined"
	) {
		return;
	}

	settingsSubscriptionAttached = true;
	const generation = settingsGeneration;
	settingsSubscriptionCleanup = subscribeStoredJsonChanges(
		STORAGE_KEY,
		(value) => {
			if (generation !== settingsGeneration) return;
			const didChange = updateSettingsCache(value);
			if (didChange) {
				emitSettingsUpdated();
			}
		},
	);
}

export function disposeSettingsSubscription() {
	settingsSuspended = true;
	settingsGeneration += 1;
	settingsSubscriptionCleanup?.();
	settingsSubscriptionCleanup = null;
	settingsSubscriptionAttached = false;
	settingsInitialization = null;
}

export function initializeSettings(): Promise<NicoJKSettings> {
	settingsSuspended = false;
	ensureSettingsSubscription();

	if (!settingsInitialization) {
		const generation = settingsGeneration;
		settingsInitialization = (async () => {
			try {
				const { value } =
					await readStoredJsonWithFallback<unknown>(STORAGE_KEY);
				if (generation !== settingsGeneration) return settingsCache;
				const didChange = updateSettingsCache(value);

				if (didChange) {
					emitSettingsUpdated();
				}
			} catch (error) {
				console.error("Failed to initialize settings", error);
			}

			return settingsCache;
		})();
	}

	return settingsInitialization;
}

export function getSettings(): NicoJKSettings {
	ensureSettingsSubscription();
	if (!settingsInitialized) {
		updateSettingsCache(DEFAULT_SETTINGS);
		if (!settingsSuspended) {
			void initializeSettings();
		}
	}
	return settingsCache;
}

export function saveSettings(settings: NicoJKSettings) {
	ensureSettingsSubscription();
	updateSettingsCache(settings);
	void writeStoredJsonWithFallback(STORAGE_KEY, settingsCache).catch(
		(error) => {
			console.error("Failed to persist settings", error);
		},
	);
	emitSettingsUpdated();
	return settingsCache;
}

export function addNGWord(word: string) {
	const s = getSettings();
	if (!s.ngWords.includes(word)) {
		s.ngWords.push(word);
		saveSettings(s);
	}
}

export function removeNGWord(word: string) {
	const s = getSettings();
	s.ngWords = s.ngWords.filter((w) => w !== word);
	saveSettings(s);
}

export function addNGId(id: string) {
	const s = getSettings();
	if (!s.ngIds.includes(id)) {
		s.ngIds.push(id);
		saveSettings(s);
	}
}

export function removeNGId(id: string) {
	const s = getSettings();
	s.ngIds = s.ngIds.filter((i) => i !== id);
	saveSettings(s);
}

export function addNGCommand(command: string) {
	const s = getSettings();
	if (!s.ngCommands.includes(command)) {
		s.ngCommands.push(command);
		saveSettings(s);
	}
}

export function removeNGCommand(command: string) {
	const s = getSettings();
	s.ngCommands = s.ngCommands.filter((c) => c !== command);
	saveSettings(s);
}

export function isNG(
	comment: string | undefined,
	userId: string | undefined,
): boolean {
	const s = getSettings();
	if (userId && s.ngIds.includes(userId)) return true;
	if (comment && s.ngWords.some((word) => comment.includes(word))) return true;
	return false;
}

export function filterMail(mail: string[] | undefined): string[] {
	if (!mail) return [];
	const s = getSettings();
	if (s.ngCommands.length === 0) return mail;
	return mail.filter((m) => m != null && !s.ngCommands.includes(m));
}
