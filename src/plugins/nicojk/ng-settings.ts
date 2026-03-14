export interface NicoJKSettings {
	ngWords: string[];
	ngIds: string[];
	opacity: number;
}

const STORAGE_KEY = "nicojk_settings_v2";

export function getSettings(): NicoJKSettings {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		try {
			return JSON.parse(stored);
		} catch (e) {
			console.error("Failed to parse settings", e);
		}
	}
	return { ngWords: [], ngIds: [], opacity: 0.8 };
}

export function saveSettings(settings: NicoJKSettings) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	window.dispatchEvent(new Event("nicojk_settings_updated"));
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

export function isNG(comment: string, userId: string): boolean {
	const s = getSettings();
	if (s.ngIds.includes(userId)) return true;
	if (s.ngWords.some((word) => comment.includes(word))) return true;
	return false;
}
