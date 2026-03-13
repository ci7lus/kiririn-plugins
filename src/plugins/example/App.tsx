import { useEffect, useState } from "react";
import { initBridge } from "../../kiririn-bridge";
import type { DisplayArea, Playable } from "../../Plugin.d.ts";

function App() {
	const [playable, setPlayable] = useState<Playable | null>(null);
	const [area, setArea] = useState<DisplayArea | null>(null);

	useEffect(() => {
		const bridge = initBridge();
		setPlayable(bridge.getPlayable());
		setArea(bridge.getDisplayArea());
		bridge.onPlayableUpdate(setPlayable);
		bridge.onDisplayAreaUpdate(setArea);
	}, []);

	if (!playable || !area)
		return <div className="p-5 text-white bg-black/50">読み込み中...</div>;

	// エリアタイプに応じたコンテナのスタイル
	const isFullScreen = area.type === "pluginScreen";
	const containerBase = isFullScreen
		? "w-full h-full"
		: "border border-white/10 shadow-2xl rounded-2xl";

	return (
		<div className="flex items-center justify-center min-h-screen bg-transparent p-4 transition-all duration-300">
			<div
				style={{
					width: isFullScreen ? "100%" : "",
					height: isFullScreen ? "100%" : "",
					maxWidth: isFullScreen ? "none" : "calc(100vw - 2rem)",
					maxHeight: isFullScreen ? "none" : "calc(100vh - 2rem)",
				}}
				className={`${containerBase} bg-black/70 text-white text-sm box-border flex flex-col backdrop-blur-md relative transition-all duration-500 ease-in-out`}
			>
				{/* コンテンツエリア */}
				<div className="p-4 flex-1 overflow-auto scrollbar-hide">
					<h2
						className={`m-0 mb-2 font-bold leading-tight ${area.type === "playerOverlay" ? "text-base" : "text-xl"}`}
					>
						{playable.title}
					</h2>

					{playable.service && (
						<div className="mb-2 text-gray-400 font-medium text-xs">
							{playable.service.name}{" "}
							<span className="opacity-60 font-normal">
								({playable.service.type.description})
							</span>
						</div>
					)}

					{playable.program && (
						<div
							className={area.type === "playerOverlay" ? "hidden sm:block" : ""}
						>
							<p className="my-1 line-clamp-3 leading-relaxed text-gray-200 text-xs opacity-90">
								{playable.program.description}
							</p>
						</div>
					)}
				</div>

				{/* フッター情報 */}
				<div className="px-3 py-2 bg-white/5 border-t border-white/10 text-[9px] text-gray-500 flex justify-between items-center shrink-0">
					<div className="flex items-center gap-2">
						<span className="bg-white/10 px-1.5 py-0.5 rounded text-white font-black tracking-tighter">
							{area.type}
						</span>
						<span className="opacity-60">
							{area.width} × {area.height}
						</span>
					</div>
				</div>

				{/* デバッグ用切り替えボタン (window.kiririnに特定のプロパティがあるかで判定) */}
				{typeof (window.kiririn as any).nextAreaPattern === "function" && (
					<button
						type="button"
						onClick={() => (window.kiririn as any).nextAreaPattern()}
						className="absolute -top-3 -right-3 bg-indigo-600 hover:bg-indigo-500 text-white text-[9px] px-3 py-1.5 rounded-full shadow-xl font-bold uppercase transition-all hover:scale-110 active:scale-95 z-50 border border-white/20"
					>
						Switch Area
					</button>
				)}
			</div>
		</div>
	);
}

export default App;
