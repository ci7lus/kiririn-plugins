import { resolve } from "node:path";
import process from "node:process";

export type AreaType = "playerOverlay" | "pluginScreen" | "pluginSettings";

export type KiririnPluginManifest = {
	name: string;
	identifier: string;
	version: string;
	author: string;
	url: string;
	displayAreas: AreaType[];
	contextId?: string;
	allowedURLPatterns?: string[];
};

export type KiririnPlugin = {
	id: string;
	input: string;
	manifest: KiririnPluginManifest;
};

export const plugins: KiririnPlugin[] = [
	{
		id: "example",
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
		id: "nicojk",
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
