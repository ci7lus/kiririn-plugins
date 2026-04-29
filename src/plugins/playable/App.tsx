import { useEffect, useState } from "react";
import { initBridge } from "../../kiririn-bridge";
import type { DisplayArea, Playable } from "../../Plugin.d.ts";

function App() {
	const [playable, setPlayable] = useState<Playable | null>(null);
	const [area, setArea] = useState<DisplayArea | null>(null);

	useEffect(() => {
		const bridge = initBridge();

		const update = () => {
			const area = bridge.getDisplayArea();
			setArea(area);

			const playerID = area.playerID || bridge.getFocusedPlayerID();
			if (playerID) {
				setPlayable(bridge.getPlayable(playerID));
			} else {
				const playables = bridge.getPlayables();
				setPlayable(playables.length > 0 ? playables[0] : null);
			}
		};

		update();
		bridge.onDisplayAreaChange(update);
		bridge.onPlayablesChange(update);
		bridge.onFocusedPlayerIDChange(update);
	}, []);

	if (!playable || !area) return null;

	const isFullScreen = area.type === "pluginScreen";
	const isOverlay = area.type === "playerOverlay";

	// 配置の決定:
	// - playerOverlay: 画面下部に配置。pointer-events-noneで外側をクリック可能に。
	// - pluginSettings: 中央に配置。
	// - pluginScreen: 全画面。
	const wrapperClass = isOverlay
		? "fixed bottom-0 left-0 w-full p-6 flex justify-start items-end pointer-events-none"
		: area.type === "pluginSettings"
			? "flex items-center justify-center min-h-screen p-4"
			: "w-screen h-screen p-0";

	return (
		<div
			className={`${wrapperClass} bg-transparent transition-all duration-500`}
		>
			<div
				style={{
					width: isFullScreen ? "100%" : area.width,
					height: isFullScreen ? "100%" : area.height,
					maxWidth: isFullScreen ? "none" : "calc(100vw - 3rem)",
					maxHeight: isFullScreen ? "none" : "calc(100vh - 3rem)",
				}}
				className={`
          ${isFullScreen ? "rounded-0" : "rounded-2xl border border-white/10 shadow-2xl"}
          bg-black/70 text-white text-sm box-border flex flex-col backdrop-blur-md relative
          transition-all duration-500 ease-in-out pointer-events-auto
        `}
			>
				{/* コンテンツエリア */}
				<div className="p-4 flex-1 overflow-auto scrollbar-hide">
					<h2
						className={`m-0 mb-1 font-bold leading-tight ${isOverlay ? "text-base" : "text-xl"}`}
					>
						{playable.title}
					</h2>

					{playable.service && (
						<div className="mb-2 text-gray-400 font-medium text-[10px] uppercase tracking-wider opacity-80">
							{playable.service.name}
						</div>
					)}

					{playable.program && !isOverlay && (
						<p className="my-1 line-clamp-3 leading-relaxed text-gray-200 text-xs opacity-90">
							{playable.program.description}
						</p>
					)}
				</div>

				{/* フッター情報 */}
				<div className="px-3 py-1.5 bg-white/5 border-t border-white/10 text-[9px] text-gray-500 flex justify-between items-center shrink-0">
					<div className="flex items-center gap-2">
						<span className="bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-bold uppercase tracking-tighter text-[8px]">
							{area.type}
						</span>
						<span className="opacity-40">
							{area.width} × {area.height}
						</span>
					</div>
					{isOverlay && (
						<span className="text-red-500 animate-pulse font-bold text-[8px] flex items-center gap-1">
							<span className="w-1.5 h-1.5 bg-red-500 rounded-full"></span> LIVE
						</span>
					)}
				</div>

				{/* デバッグ用切り替えボタン */}
				{typeof (window.kiririn as any).nextAreaPattern === "function" && (
					<button
						type="button"
						onClick={() => (window.kiririn as any).nextAreaPattern()}
						className="absolute -top-3 -right-3 bg-indigo-600 hover:bg-indigo-500 text-white text-[9px] px-3 py-1.5 rounded-full shadow-xl font-bold uppercase transition-all hover:scale-110 active:scale-95 z-50 border border-white/20"
					>
						Switch
					</button>
				)}
			</div>
		</div>
	);
}

export default App;
