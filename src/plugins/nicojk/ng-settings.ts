export interface NicoJKSettings {
	ngWords: string[];
	ngIds: string[];
	ngCommands: string[];
	opacity: number;
	secondarySourceOpacity: number;
	chapterWindowSeconds: number;
	chapterCooldownSeconds: number;
	chapterMinimumCount: number;
	chapterSeekLeadSeconds: number;
	maxRecordedReplayAirings: number;
	hideSecondarySourceComments: boolean;
}

export const STORAGE_KEY = "nicojk_settings_v4";
export const SETTINGS_UPDATED_EVENT = "nicojk_settings_updated";

const DEFAULT_SETTINGS: NicoJKSettings = {
	ngWords: [],
	ngIds: [],
	ngCommands: [],
	opacity: 0.8,
	secondarySourceOpacity: 1,
	chapterWindowSeconds: 10,
	chapterCooldownSeconds: 60,
	chapterMinimumCount: 3,
	chapterSeekLeadSeconds: 5,
	maxRecordedReplayAirings: 5,
	hideSecondarySourceComments: false,
};

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

function normalizeSettings(value: unknown): NicoJKSettings {
	const stored =
		typeof value === "object" && value != null
			? (value as Partial<Record<keyof NicoJKSettings, unknown>>)
			: {};

	return {
		ngWords: normalizeStringArray(stored.ngWords),
		ngIds: normalizeStringArray(stored.ngIds),
		ngCommands: normalizeStringArray(stored.ngCommands),
		opacity: normalizeOpacity(stored.opacity, DEFAULT_SETTINGS.opacity),
		secondarySourceOpacity: normalizeOpacity(
			stored.secondarySourceOpacity,
			DEFAULT_SETTINGS.secondarySourceOpacity,
		),
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
		maxRecordedReplayAirings: normalizeInteger(
			stored.maxRecordedReplayAirings,
			DEFAULT_SETTINGS.maxRecordedReplayAirings,
			0,
			50,
		),
		hideSecondarySourceComments:
			typeof stored.hideSecondarySourceComments === "boolean"
				? stored.hideSecondarySourceComments
				: DEFAULT_SETTINGS.hideSecondarySourceComments,
	};
}

export function getSettings(): NicoJKSettings {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		try {
			return normalizeSettings(JSON.parse(stored));
		} catch (e) {
			console.error("Failed to parse settings", e);
		}
	}
	return DEFAULT_SETTINGS;
}

export function saveSettings(settings: NicoJKSettings) {
	const normalized = normalizeSettings(settings);
	localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
	window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
	return normalized;
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
