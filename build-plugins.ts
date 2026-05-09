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

type KiririnPlugin = {
	input: string;
	name: string;
	title: string;
	id: string;
	version: string;
	author: string;
	link: string;
	areas: AreaType[];
	allowedURLs: string[];
};

const plugins: KiririnPlugin[] = [
	{
		input: resolve(process.cwd(), "example.html"),
		name: "example",
		title: "Kiririn Plugin Example",
		id: "io.github.ci7lus.kiririn-plugins.example",
		version: "0.1.0",
		author: "ci7lus",
		link: "https://github.com/ci7lus/kiririn-plugins",
		areas: ["playerOverlay", "pluginScreen", "pluginSettings"],
		allowedURLs: ["https://o481625\\.ingest\\.us\\.sentry\\.io/.*"],
	},
	{
		input: resolve(process.cwd(), "nicojk.html"),
		name: "nicojk",
		title: "NicoJK",
		id: "io.github.ci7lus.kiririn-plugins.nicojk",
		version: "0.1.0",
		author: "ci7lus",
		link: "https://github.com/ci7lus/kiririn-plugins",
		areas: ["playerOverlay", "pluginScreen", "pluginSettings"],
		allowedURLs: [
			"https://o481625\\.ingest\\.us\\.sentry\\.io/.*",
			"https://cdn\\.jsdelivr\\.net/gh/neneka/saya-definitions@master/definitions\\.json",
			"https://cal\\.syoboi\\.jp/.*",
			"https://jikkyo\\.tsukumijima\\.net/.*",
			"wss://nx-jikkyo\\.tsukumijima\\.net/.*",
		],
	},
];

async function buildAll() {
	const distPath = resolve(process.cwd(), "dist");
	try {
		await fs.rm(distPath, { recursive: true, force: true });
	} catch {}

	for (const plugin of plugins) {
		console.log(`Building plugin: ${plugin.name}...`);

		const tags: HtmlTagDescriptor[] = [
			{
				tag: "title",
				children: plugin.title,
			},
			{
				tag: "meta",
				attrs: { name: "kiririn:id", content: plugin.id },
			},
			{
				tag: "meta",
				attrs: { name: "kiririn:version", content: plugin.version },
			},
			{
				tag: "meta",
				attrs: { name: "kiririn:author", content: plugin.author },
			},
			{
				tag: "meta",
				attrs: { name: "kiririn:link", content: plugin.link },
			},
			{
				tag: "meta",
				attrs: { name: "kiririn:areas", content: plugin.areas.join(",") },
			},
			{
				tag: "meta",
				attrs: {
					name: "kiririn:allowedURLs",
					content: JSON.stringify(plugin.allowedURLs),
				},
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
				__PLUGIN_ID__: JSON.stringify(plugin.id),
				__PLUGIN_VERSION__: JSON.stringify(plugin.version),
			},
		});
		console.log(`Plugin ${plugin.name} built successfully.`);
	}
}

buildAll().catch((err) => {
	console.error(err);
	process.exit(1);
});
