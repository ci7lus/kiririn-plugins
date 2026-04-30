export interface NicoJKSettings {
	ngWords: string[];
	ngIds: string[];
	ngCommands: string[];
	opacity: number;
	showDebugInfo: boolean;
}

const STORAGE_KEY = "nicojk_settings_v4"; // Bump version because of new property

export function getSettings(): NicoJKSettings {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		try {
			return JSON.parse(stored);
		} catch (e) {
			console.error("Failed to parse settings", e);
		}
	}
	return {
		ngWords: [],
		ngIds: [],
		ngCommands: [],
		opacity: 0.8,
		showDebugInfo: false,
	};
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

export function isNG(comment: string | undefined, userId: string | undefined): boolean {
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
