import { Ban, Plus, Sliders, Trash2, Type } from "lucide-react";
import { useState } from "react";
import {
	addNGId,
	addNGWord,
	getSettings,
	type NicoJKSettings,
	removeNGId,
	removeNGWord,
	saveSettings,
} from "../ng-settings";

export default function PluginSettings() {
	const [settings, setSettings] = useState<NicoJKSettings>(getSettings());
	const [newWord, setNewWord] = useState("");
	const [newId, setNewId] = useState("");

	const refresh = () => setSettings(getSettings());

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
		removeNGWord(word);
		refresh();
	};

	const handleDeleteId = (id: string) => {
		removeNGId(id);
		refresh();
	};

	const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = parseFloat(e.target.value);
		const newSettings = { ...settings, opacity: val };
		setSettings(newSettings);
		saveSettings(newSettings);
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
						<div className="flex flex-col gap-2">
							<div className="flex justify-between text-sm">
								<p className="text-gray-300">コメントの濃度 (不透明度)</p>
								<span className="text-indigo-400 font-mono">
									{Math.round(settings.opacity * 100)}%
								</span>
							</div>
							<input
								type="range"
								min="0.1"
								max="1.0"
								step="0.05"
								value={settings.opacity}
								onChange={handleOpacityChange}
								className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
							/>
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
							className="flex-1 bg-[#333] border border-gray-600 rounded px-3 py-1 text-sm focus:outline-none focus:border-red-500"
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
								<span>{word}</span>
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
							className="flex-1 bg-[#333] border border-gray-600 rounded px-3 py-1 text-sm focus:outline-none focus:border-red-500"
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
								<span className="font-mono text-xs opacity-70">{id}</span>
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
			</div>
		</div>
	);
}
