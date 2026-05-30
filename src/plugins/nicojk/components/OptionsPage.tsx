import { Plus, Sliders, Trash2, Type } from "lucide-react";
import { useState } from "react";
import {
	addNGCommand,
	addNGId,
	addNGWord,
	getSettings,
	type NicoJKSettings,
	removeNGCommand,
	removeNGId,
	removeNGWord,
	saveSettings,
} from "../ng-settings";

type NumericSettingKey =
	| "chapterWindowSeconds"
	| "chapterCooldownSeconds"
	| "chapterMinimumCount"
	| "chapterSeekLeadSeconds"
	| "maxRecordedReplayAirings";

type NumericSettingDrafts = Record<NumericSettingKey, string>;

const NUMERIC_SETTING_FIELDS: Array<{
	key: NumericSettingKey;
	label: string;
	description: string;
	min: number;
	max: number;
	step: number;
}> = [
	{
		key: "maxRecordedReplayAirings",
		label: "過去ログ候補数",
		description: "別放送日程として表示する過去ログコメントソースの最大数",
		min: 0,
		max: 50,
		step: 1,
	},
	{
		key: "chapterWindowSeconds",
		label: "チャプター判定幅",
		description: "コメントを同じチャプター候補として束ねる秒数",
		min: 1,
		max: 120,
		step: 1,
	},
	{
		key: "chapterCooldownSeconds",
		label: "チャプター間隔",
		description: "連続したチャプター候補を抑制する最小秒数",
		min: 0,
		max: 1800,
		step: 1,
	},
	{
		key: "chapterMinimumCount",
		label: "チャプター最小件数",
		description: "1 つの候補として採用するための最小コメント数",
		min: 1,
		max: 50,
		step: 1,
	},
	{
		key: "chapterSeekLeadSeconds",
		label: "チャプター余白秒数",
		description: "チャプター移動時に余白として持たせる秒数",
		min: 0,
		max: 300,
		step: 1,
	},
];

function buildRevealKey(value: string) {
	return `word:${value}`;
}

function maskSettingValue(value: string) {
	const chars = Array.from(value);
	if (chars.length <= 1) {
		return value;
	}
	if (chars.length === 2) {
		return `${chars[0]}*`;
	}
	return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

function buildNumericDrafts(settings: NicoJKSettings): NumericSettingDrafts {
	return {
		chapterWindowSeconds: String(settings.chapterWindowSeconds),
		chapterCooldownSeconds: String(settings.chapterCooldownSeconds),
		chapterMinimumCount: String(settings.chapterMinimumCount),
		chapterSeekLeadSeconds: String(settings.chapterSeekLeadSeconds),
		maxRecordedReplayAirings: String(settings.maxRecordedReplayAirings),
	};
}

export default function OptionsPage() {
	const initialSettings = getSettings();
	const [settings, setSettings] = useState<NicoJKSettings>(initialSettings);
	const [newWord, setNewWord] = useState("");
	const [newId, setNewId] = useState("");
	const [newCommand, setNewCommand] = useState("");
	const [numericDrafts, setNumericDrafts] = useState<NumericSettingDrafts>(() =>
		buildNumericDrafts(initialSettings),
	);
	const [revealedValues, setRevealedValues] = useState<Set<string>>(
		() => new Set(),
	);

	const syncSettings = (nextSettings: NicoJKSettings) => {
		setSettings(nextSettings);
		setNumericDrafts(buildNumericDrafts(nextSettings));
	};

	const refresh = () => syncSettings(getSettings());

	const toggleReveal = (value: string) => {
		const revealKey = buildRevealKey(value);
		setRevealedValues((prev) => {
			const next = new Set(prev);
			if (next.has(revealKey)) {
				next.delete(revealKey);
			} else {
				next.add(revealKey);
			}
			return next;
		});
	};

	const hideReveal = (value: string) => {
		const revealKey = buildRevealKey(value);
		setRevealedValues((prev) => {
			if (!prev.has(revealKey)) {
				return prev;
			}
			const next = new Set(prev);
			next.delete(revealKey);
			return next;
		});
	};

	const commitNumericSetting = (key: NumericSettingKey) => {
		const draft = numericDrafts[key].trim();
		if (draft === "") {
			setNumericDrafts((prev) => ({
				...prev,
				[key]: String(settings[key]),
			}));
			return;
		}

		syncSettings(
			saveSettings({
				...settings,
				[key]: Number(draft),
			}),
		);
	};

	const handleNumericDraftChange = (key: NumericSettingKey, value: string) => {
		setNumericDrafts((prev) => ({
			...prev,
			[key]: value,
		}));
	};

	const handleSecondarySourceOpacityChange = (
		e: React.ChangeEvent<HTMLInputElement>,
	) => {
		const val = parseFloat(e.target.value);
		syncSettings(
			saveSettings({
				...settings,
				secondarySourceOpacity: val,
			}),
		);
	};

	const handleAddWord = (e: React.FormEvent) => {
		e.preventDefault();
		if (newWord.trim()) {
			addNGWord(newWord.trim());
			setNewWord("");
			refresh();
		}
	};

	const handleAddId = (e: React.FormEvent) => {
		e.preventDefault();
		if (newId.trim()) {
			addNGId(newId.trim());
			setNewId("");
			refresh();
		}
	};

	const handleDeleteWord = (word: string) => {
		hideReveal(word);
		removeNGWord(word);
		refresh();
	};

	const handleDeleteId = (id: string) => {
		removeNGId(id);
		refresh();
	};

	const handleAddCommand = (e: React.FormEvent) => {
		e.preventDefault();
		if (newCommand.trim()) {
			addNGCommand(newCommand.trim());
			setNewCommand("");
			refresh();
		}
	};

	const handleDeleteCommand = (command: string) => {
		removeNGCommand(command);
		refresh();
	};

	return (
		<div className="p-6 bg-[#1a1a1a] text-white min-h-full max-w-2xl mx-auto">
			<h2 className="text-xl font-bold mb-6 border-b border-gray-700 pb-2">
				NicoJK 設定
			</h2>

			<div className="flex flex-col gap-6">
				{/* Display Settings */}
				<div className="bg-[#252525] p-4 rounded-lg shadow-lg">
					<div className="flex items-center gap-2 mb-4 text-indigo-400">
						<Sliders size={20} />
						<h3 className="font-bold">表示設定</h3>
					</div>
					<div className="rounded-md border border-gray-700 bg-[#1f1f1f] p-3">
						<div className="mb-2 flex justify-between text-sm">
							<span className="font-medium text-gray-100">
								セカンダリコメントの濃度倍率
							</span>
							<span className="font-mono text-indigo-300">
								{Math.round(settings.secondarySourceOpacity * 100)}%
							</span>
						</div>
						<p className="mb-3 text-xs leading-relaxed text-gray-400">
							別/サイマルコメントに追加で適用されます。
						</p>
						<input
							type="range"
							min="0.0"
							max="1.0"
							step="0.05"
							value={settings.secondarySourceOpacity}
							onChange={handleSecondarySourceOpacityChange}
							className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-gray-700 accent-indigo-500"
						/>
					</div>
				</div>

				{/* NG Settings */}
				<div className="bg-[#252525] p-4 rounded-lg shadow-lg">
					<div className="flex items-center gap-2 mb-6 text-red-400">
						<Type size={20} />
						<h3 className="font-bold">NG設定</h3>
					</div>
					<div className="space-y-4">
						{/* NG Words */}
						<div>
							<div className="mb-3 text-sm font-medium text-gray-200">
								NGワード
							</div>
							<form onSubmit={handleAddWord} className="flex gap-2 mb-3">
								<input
									type="text"
									value={newWord}
									onChange={(e) => setNewWord(e.target.value)}
									placeholder="単語を追加..."
									className="flex-1 bg-[#333] border border-gray-600 rounded px-3 py-1 text-base focus:outline-none focus:border-red-500"
								/>
								<button
									type="submit"
									className="bg-red-600 hover:bg-red-700 p-2 rounded text-white"
								>
									<Plus size={16} />
								</button>
							</form>
							<div className="space-y-2 max-h-32 overflow-y-auto pr-1">
								{settings.ngWords.length === 0 && (
									<p className="text-gray-500 text-sm italic">登録なし</p>
								)}
								{settings.ngWords.map((word) => (
									<div
										key={word}
										className="flex justify-between items-center bg-[#333] px-3 py-2 rounded text-sm"
									>
										<button
											type="button"
											onClick={() => toggleReveal(word)}
											className="flex-1 text-left truncate pr-3 text-white/90 active:text-white"
											aria-label={`NGワードを${revealedValues.has(buildRevealKey(word)) ? "非表示" : "表示"}に切り替え`}
										>
											{revealedValues.has(buildRevealKey(word))
												? word
												: maskSettingValue(word)}
										</button>
										<button
											type="button"
											onClick={() => handleDeleteWord(word)}
											className="text-gray-400 hover:text-red-400"
										>
											<Trash2 size={14} />
										</button>
									</div>
								))}
							</div>
						</div>
						{/* NG IDs */}
						<div className="border-t border-gray-700 pt-4">
							<div className="mb-3 text-sm font-medium text-gray-200">
								NG ID
							</div>
							<form onSubmit={handleAddId} className="flex gap-2 mb-3">
								<input
									type="text"
									value={newId}
									onChange={(e) => setNewId(e.target.value)}
									placeholder="IDを追加..."
									className="flex-1 bg-[#333] border border-gray-600 rounded px-3 py-1 text-base focus:outline-none focus:border-red-500"
								/>
								<button
									type="submit"
									className="bg-red-600 hover:bg-red-700 p-2 rounded text-white"
								>
									<Plus size={16} />
								</button>
							</form>
							<div className="space-y-2 max-h-32 overflow-y-auto pr-1">
								{settings.ngIds.length === 0 && (
									<p className="text-gray-500 text-sm italic">登録なし</p>
								)}
								{settings.ngIds.map((id) => (
									<div
										key={id}
										className="flex justify-between items-center bg-[#333] px-3 py-2 rounded text-sm"
									>
										<span className="flex-1 truncate pr-3 font-mono text-xs opacity-70">
											{id}
										</span>
										<button
											type="button"
											onClick={() => handleDeleteId(id)}
											className="text-gray-400 hover:text-red-400"
										>
											<Trash2 size={14} />
										</button>
									</div>
								))}
							</div>
						</div>
						{/* NG Commands */}
						<div className="border-t border-gray-700 pt-4">
							<div className="mb-3 text-sm font-medium text-gray-200">
								NGコマンド
							</div>
							<form onSubmit={handleAddCommand} className="flex gap-2 mb-3">
								<input
									type="text"
									value={newCommand}
									onChange={(e) => setNewCommand(e.target.value)}
									placeholder="コマンドを追加 (例: shita)..."
									className="flex-1 bg-[#333] border border-gray-600 rounded px-3 py-1 text-base focus:outline-none focus:border-red-500"
								/>
								<button
									type="submit"
									className="bg-red-600 hover:bg-red-700 p-2 rounded text-white"
								>
									<Plus size={16} />
								</button>
							</form>
							<div className="space-y-2 max-h-32 overflow-y-auto pr-1">
								{settings.ngCommands.length === 0 && (
									<p className="text-gray-500 text-sm italic">登録なし</p>
								)}
								{settings.ngCommands.map((command) => (
									<div
										key={command}
										className="flex justify-between items-center bg-[#333] px-3 py-2 rounded text-sm"
									>
										<span className="flex-1 truncate pr-3 font-mono text-xs opacity-70">
											{command}
										</span>
										<button
											type="button"
											onClick={() => handleDeleteCommand(command)}
											className="text-gray-400 hover:text-red-400"
										>
											<Trash2 size={14} />
										</button>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>

				{/* Tuning Settings */}
				<div className="bg-[#252525] p-4 rounded-lg shadow-lg">
					<div className="flex items-center gap-2 mb-4 text-indigo-400">
						<Sliders size={20} />
						<h3 className="font-bold">コメント取得設定</h3>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						{NUMERIC_SETTING_FIELDS.map((field) => (
							<label
								key={field.key}
								className="flex flex-col gap-2 rounded-md border border-gray-700 bg-[#1f1f1f] p-3"
							>
								<div>
									<div className="text-sm font-medium text-gray-100">
										{field.label}
									</div>
									<div className="mt-1 text-xs leading-relaxed text-gray-400">
										{field.description}
									</div>
								</div>
								<input
									type="number"
									inputMode="numeric"
									min={field.min}
									max={field.max}
									step={field.step}
									value={numericDrafts[field.key]}
									onChange={(e) =>
										handleNumericDraftChange(field.key, e.target.value)
									}
									onBlur={() => commitNumericSetting(field.key)}
									onKeyDown={(e) => {
										if (e.key !== "Enter") {
											return;
										}
										e.preventDefault();
										commitNumericSetting(field.key);
										e.currentTarget.blur();
									}}
									className="w-full rounded border border-gray-600 bg-[#333] px-3 py-2 text-base text-white focus:border-indigo-500 focus:outline-none"
								/>
								<div className="text-[11px] text-gray-500">
									範囲: {field.min} - {field.max}
								</div>
							</label>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
