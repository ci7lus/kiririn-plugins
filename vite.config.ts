import { execSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type HtmlTagDescriptor } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { plugins } from "./scripts/plugins-manifest";

let revision: string | undefined;
try {
	revision = `"${execSync("git rev-parse --short HEAD").toString().trim()}"`;
} catch (error) {
	console.error(error);
}

export default defineConfig(({ command, mode }) => {
	// 開発モード（serve）またはビルド対象のプラグインを特定
	// ビルド時は mode にプラグインの id が入ることを想定
	const targetPlugin = plugins.find((p) => p.id === mode);

	// 全てのプラグインの入力を取得（dev用）
	const allInputs = Object.fromEntries(plugins.map((p) => [p.id, p.input]));

	return {
		plugins: [
			react(),
			tailwindcss(),
			viteSingleFile(),
			{
				name: "kiririn-plugin-meta",
				transformIndexHtml(html, ctx) {
					// 現在のHTMLに対応するプラグインを探す
					const plugin = plugins.find((p) => ctx.filename.endsWith(p.input));
					if (!plugin) return html;

					const tags: HtmlTagDescriptor[] = [
						{
							tag: "title",
							children: plugin.manifest.name,
						},
						{
							tag: "script",
							attrs: {
								id: "kiririn-plugin-manifest",
								type: "application/json",
							},
							children: JSON.stringify(plugin.manifest),
						},
					];
					return tags;
				},
			},
			{
				name: "kiririn-plugin-define-dev",
				apply: "serve",
				transform(code, id) {
					// dev環境では __PLUGIN_ID__ などを動的に解決するようにソースを書き換える
					if (id.endsWith("src/sentry.ts")) {
						return code
							.replace(
								/__PLUGIN_ID__/g,
								'(JSON.parse(document.getElementById("kiririn-plugin-manifest")?.textContent || "{}").identifier)',
							)
							.replace(
								/__PLUGIN_VERSION__/g,
								'(JSON.parse(document.getElementById("kiririn-plugin-manifest")?.textContent || "{}").version)',
							);
					}
					return code;
				},
			},
		],
		define: {
			__REVISION__: revision,
			// ビルド時は確定した値を、dev時は変換プラグインで対応するためダミーを入れる
			...(command === "build"
				? {
						__PLUGIN_ID__: JSON.stringify(
							targetPlugin?.manifest.identifier ?? "",
						),
						__PLUGIN_VERSION__: JSON.stringify(
							targetPlugin?.manifest.version ?? "",
						),
					}
				: {
						// serve時は transform プラグインで置換されるが、
						// 念のためグローバルでもエラーにならないようにしておく
						__PLUGIN_ID__: "undefined",
						__PLUGIN_VERSION__: "undefined",
					}),
		},
		build: {
			rollupOptions: {
				input: targetPlugin
					? targetPlugin.input
					: command === "serve"
						? allInputs
						: {},
			},
			emptyOutDir: false,
			outDir: "dist",
		},
	};
});
