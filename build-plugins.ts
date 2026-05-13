import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, type HtmlTagDescriptor, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

let revision: string | undefined;

try {
	revision = `"${execSync("git rev-parse --short HEAD").toString().trim()}"`;
} catch (error) {
	console.error(error);
}

type AreaType = "playerOverlay" | "pluginScreen" | "pluginSettings";

type KiririnPluginManifest = {
	name: string;
	identifier: string;
	version: string;
	author: string;
	url: string;
	displayAreas: AreaType[];
	contextId?: string;
	allowedURLPatterns?: string[];
};

type KiririnPlugin = {
	input: string;
	manifest: KiririnPluginManifest;
};

const plugins: KiririnPlugin[] = [
	{
		input: resolve(process.cwd(), "example.html"),
		manifest: {
			name: "Kiririn Plugin Example",
			identifier: "io.github.ci7lus.kiririn-plugins.example",
			version: "0.1.0",
			author: "ci7lus",
			url: "https://github.com/ci7lus/kiririn-plugins",
			displayAreas: ["playerOverlay", "pluginScreen", "pluginSettings"],
			contextId: "example",
			allowedURLPatterns: ["https://o481625\\.ingest\\.us\\.sentry\\.io/.*"],
		},
	},
	{
		input: resolve(process.cwd(), "nicojk.html"),
		manifest: {
			name: "NicoJK",
			identifier: "io.github.ci7lus.kiririn-plugins.nicojk",
			version: "0.1.0",
			author: "ci7lus",
			url: "https://github.com/ci7lus/kiririn-plugins",
			displayAreas: ["playerOverlay", "pluginScreen", "pluginSettings"],
			contextId: "nicojk",
			allowedURLPatterns: [
				"https://o481625\\.ingest\\.us\\.sentry\\.io/.*",
				"https://cdn\\.jsdelivr\\.net/gh/neneka/saya-definitions@master/definitions\\.json",
				"https://cal\\.syoboi\\.jp/.*",
				"https://jikkyo\\.tsukumijima\\.net/.*",
				"wss://nx-jikkyo\\.tsukumijima\\.net/.*",
			],
		},
	},
];

async function buildAll() {
	const distPath = resolve(process.cwd(), "dist");
	try {
		await fs.rm(distPath, { recursive: true, force: true });
	} catch {}

	for (const plugin of plugins) {
		console.log(`Building plugin: ${plugin.manifest.name}...`);

		const tags: HtmlTagDescriptor[] = [
			{
				tag: "title",
				children: plugin.manifest.name,
			},
			{
				tag: "script",
				attrs: { id: "kiririn-plugin-manifest", type: "application/json" },
				children: JSON.stringify(plugin.manifest),
			},
		];
		const pluginTagMeta: Plugin = {
			name: "html-tag-meta",
			transformIndexHtml() {
				return tags;
			},
		};

		await build({
			configFile: false,
			plugins: [pluginTagMeta, react(), tailwindcss(), viteSingleFile()],
			build: {
				rollupOptions: {
					input: plugin.input,
				},
				emptyOutDir: false, // 前のプラグインの出力を消さないようにする
				outDir: "dist",
			},
			define: {
				__REVISION__: revision,
				__PLUGIN_ID__: JSON.stringify(plugin.manifest.identifier),
				__PLUGIN_VERSION__: JSON.stringify(plugin.manifest.version),
			},
		});
		console.log(`Plugin ${plugin.manifest.name} built successfully.`);
	}
}

buildAll().catch((err) => {
	console.error(err);
	process.exit(1);
});
