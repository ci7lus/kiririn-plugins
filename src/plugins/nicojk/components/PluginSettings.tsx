import { Ban, Command, Plus, Sliders, Trash2, Type } from "lucide-react";
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

type RevealGroup = "word" | "id" | "command";

function buildRevealKey(group: RevealGroup, value: string) {
	return `${group}:${value}`;
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

export default function PluginSettings() {
	const [settings, setSettings] = useState<NicoJKSettings>(getSettings());
	const [newWord, setNewWord] = useState("");
	const [newId, setNewId] = useState("");
	const [newCommand, setNewCommand] = useState("");
	const [revealedValues, setRevealedValues] = useState<Set<string>>(
		() => new Set(),
	);

	const refresh = () => setSettings(getSettings());

	const toggleReveal = (group: RevealGroup, value: string) => {
		const revealKey = buildRevealKey(group, value);
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

	const hideReveal = (group: RevealGroup, value: string) => {
		const revealKey = buildRevealKey(group, value);
		setRevealedValues((prev) => {
			if (!prev.has(revealKey)) {
				return prev;
			}
			const next = new Set(prev);
			next.delete(revealKey);
			return next;
		});
	};

	const displayValue = (group: RevealGroup, value: string) => {
		return revealedValues.has(buildRevealKey(group, value))
			? value
			: maskSettingValue(value);
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
		hideReveal("word", word);
		removeNGWord(word);
		refresh();
	};

	const handleDeleteId = (id: string) => {
		hideReveal("id", id);
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
		hideReveal("command", command);
		removeNGCommand(command);
		refresh();
	};

	return (
		<div className="p-6 bg-[#1a1a1a] text-white min-h-full max-w-2xl mx-auto">
			<h2 className="text-xl font-bold mb-6 border-b border-gray-700 pb-2">
				NicoJK 設定
			</h2>

			<div className="flex flex-col gap-6">
				{/* Visual Settings */}
				<div className="bg-[#252525] p-4 rounded-lg shadow-lg">
					<div className="flex items-center gap-2 mb-4 text-indigo-400">
						<Sliders size={20} />
						<h3 className="font-bold">表示設定</h3>
					</div>
					<div className="space-y-4">
						<div className="flex items-center justify-between py-2">
							<span className="text-sm text-gray-300">デバッグ情報を表示</span>
							<button
								type="button"
								onClick={() => {
									const newSettings = {
										...settings,
										showDebugInfo: !settings.showDebugInfo,
									};
									setSettings(newSettings);
									saveSettings(newSettings);
								}}
								className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none ${
									settings.showDebugInfo ? "bg-indigo-600" : "bg-gray-700"
								}`}
							>
								<span
									className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
										settings.showDebugInfo ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</button>
						</div>
					</div>
				</div>

				{/* NG Words */}
				<div className="bg-[#252525] p-4 rounded-lg shadow-lg">
					<div className="flex items-center gap-2 mb-4 text-red-400">
						<Type size={20} />
						<h3 className="font-bold">NGワード</h3>
					</div>

					<form onSubmit={handleAddWord} className="flex gap-2 mb-4">
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

					<div className="space-y-2 max-h-40 overflow-y-auto pr-1">
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
									onClick={() => toggleReveal("word", word)}
									className="flex-1 text-left truncate pr-3 text-white/90 active:text-white"
									aria-label={`NGワードを${revealedValues.has(buildRevealKey("word", word)) ? "非表示" : "表示"}に切り替え`}
								>
									{displayValue("word", word)}
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
				<div className="bg-[#252525] p-4 rounded-lg shadow-lg">
					<div className="flex items-center gap-2 mb-4 text-red-400">
						<Ban size={20} />
						<h3 className="font-bold">NG ID</h3>
					</div>

					<form onSubmit={handleAddId} className="flex gap-2 mb-4">
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

					<div className="space-y-2 max-h-40 overflow-y-auto pr-1">
						{settings.ngIds.length === 0 && (
							<p className="text-gray-500 text-sm italic">登録なし</p>
						)}
						{settings.ngIds.map((id) => (
							<div
								key={id}
								className="flex justify-between items-center bg-[#333] px-3 py-2 rounded text-sm"
							>
								<button
									type="button"
									onClick={() => toggleReveal("id", id)}
									className="flex-1 text-left truncate pr-3 font-mono text-xs opacity-70 active:opacity-100"
									aria-label={`NG IDを${revealedValues.has(buildRevealKey("id", id)) ? "非表示" : "表示"}に切り替え`}
								>
									{displayValue("id", id)}
								</button>
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
				<div className="bg-[#252525] p-4 rounded-lg shadow-lg">
					<div className="flex items-center gap-2 mb-4 text-red-400">
						<Command size={20} />
						<h3 className="font-bold">NGコマンド</h3>
					</div>

					<form onSubmit={handleAddCommand} className="flex gap-2 mb-4">
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

					<div className="space-y-2 max-h-40 overflow-y-auto pr-1">
						{settings.ngCommands.length === 0 && (
							<p className="text-gray-500 text-sm italic">登録なし</p>
						)}
						{settings.ngCommands.map((command) => (
							<div
								key={command}
								className="flex justify-between items-center bg-[#333] px-3 py-2 rounded text-sm"
							>
								<button
									type="button"
									onClick={() => toggleReveal("command", command)}
									className="flex-1 text-left truncate pr-3 font-mono text-xs opacity-70 active:opacity-100"
									aria-label={`NGコマンドを${revealedValues.has(buildRevealKey("command", command)) ? "非表示" : "表示"}に切り替え`}
								>
									{displayValue("command", command)}
								</button>
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
	);
}
