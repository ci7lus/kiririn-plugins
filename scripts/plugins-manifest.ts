import { basename, relative, resolve } from "node:path";
import process from "node:process";

export type ExtensionPageType = "overlay" | "panel" | "options";

export type WebExtensionPluginManifest = {
	name: string;
	identifier: string;
	version: string;
	author: string;
	homepageURL: string;
	permissions?: string[];
	hostPermissions?: string[];
	updateURL?: string;
	strictMinVersion?: string;
	strictMaxVersion?: string;
};

export type WebExtensionPlugin = {
	id: string;
	entries: Partial<Record<ExtensionPageType, string>>;
	manifest: WebExtensionPluginManifest;
};

export type KiririnPlugin = WebExtensionPlugin;

const workspaceRoot = process.cwd();

export const plugins: KiririnPlugin[] = [
	{
		id: "example",
		entries: {
			overlay: resolve(workspaceRoot, "src/plugins/example/overlay.html"),
			panel: resolve(workspaceRoot, "src/plugins/example/panel.html"),
			options: resolve(workspaceRoot, "src/plugins/example/options.html"),
		},
		manifest: {
			name: "Kiririn Plugin Example",
			identifier: "io.github.ci7lus.kiririn-plugins.example",
			version: "0.1.0",
			author: "ci7lus",
			homepageURL: "https://github.com/ci7lus/kiririn-plugins",
			permissions: ["storage"],
			hostPermissions: [
				"https://example.com/*",
				"https://o481625.ingest.us.sentry.io/*",
			],
			strictMinVersion: "0.1.1",
			updateURL:
				"https://cdn.jsdelivr.net/gh/ci7lus/kiririn-plugins@main/update.json",
		},
	},
	{
		id: "nicojk",
		entries: {
			overlay: resolve(workspaceRoot, "src/plugins/nicojk/overlay.html"),
			panel: resolve(workspaceRoot, "src/plugins/nicojk/panel.html"),
			options: resolve(workspaceRoot, "src/plugins/nicojk/options.html"),
		},
		manifest: {
			name: "NicoJK",
			identifier: "io.github.ci7lus.kiririn-plugins.nicojk",
			version: "0.1.1",
			author: "ci7lus",
			homepageURL: "https://github.com/ci7lus/kiririn-plugins",
			permissions: ["storage"],
			hostPermissions: [
				"https://cal.syoboi.jp/*",
				"https://jikkyo.tsukumijima.net/*",
			],
			updateURL:
				"https://cdn.jsdelivr.net/gh/ci7lus/kiririn-plugins@main/update.json",
		},
	},
];

export function getPluginIdentifier(plugin: KiririnPlugin) {
	return plugin.manifest.identifier;
}

export function createDevelopmentMeta(plugin: KiririnPlugin) {
	return {
		id: plugin.id,
		name: plugin.manifest.name,
		identifier: getPluginIdentifier(plugin),
		version: plugin.manifest.version,
	};
}

export function findPluginByHtmlEntry(filePath: string) {
	const targetPath = resolve(filePath);
	return plugins.find((plugin) =>
		Object.values(plugin.entries).some(
			(entry) => entry != null && resolve(entry) === targetPath,
		),
	);
}

function toWorkspaceRelativePath(filePath: string) {
	return relative(workspaceRoot, filePath).replaceAll("\\", "/");
}

export function getBuiltPagePath(
	plugin: WebExtensionPlugin,
	pageType: ExtensionPageType,
) {
	const sourcePath = plugin.entries[pageType];
	return sourcePath ? toWorkspaceRelativePath(sourcePath) : null;
}

export function getPackagedPagePath(
	plugin: WebExtensionPlugin,
	pageType: ExtensionPageType,
) {
	const sourcePath = plugin.entries[pageType];
	return sourcePath ? basename(sourcePath) : null;
}

export function getPackagePath(plugin: WebExtensionPlugin) {
	return resolve(workspaceRoot, "dist", `${plugin.id}.kppx`);
}

export function createWebExtensionBuildManifest(plugin: WebExtensionPlugin) {
	const manifest = plugin.manifest;
	const overlayPage = getBuiltPagePath(plugin, "overlay");
	const panelPage = getBuiltPagePath(plugin, "panel");
	const optionsPage = getBuiltPagePath(plugin, "options");
	const views: Record<string, unknown> = {};
	const kiririnSettings: Record<string, unknown> = {
		id: manifest.identifier,
		...(manifest.updateURL ? { update_url: manifest.updateURL } : {}),
		...(manifest.strictMinVersion
			? { strict_min_version: manifest.strictMinVersion }
			: {}),
		...(manifest.strictMaxVersion
			? { strict_max_version: manifest.strictMaxVersion }
			: {}),
	};

	if (!overlayPage && !panelPage && !optionsPage) {
		throw new Error(
			`Plugin "${plugin.id}" must define at least one of overlay, panel, or options pages.`,
		);
	}

	if (overlayPage) {
		views.overlay = { page: overlayPage };
	}

	if (panelPage) {
		views.panel = { page: panelPage };
	}

	if (Object.keys(views).length > 0) {
		kiririnSettings.views = views;
	}

	return {
		manifest_version: 3,
		name: manifest.name,
		version: manifest.version,
		author: manifest.author,
		homepage_url: manifest.homepageURL,
		...(manifest.permissions && manifest.permissions.length > 0
			? { permissions: manifest.permissions }
			: {}),
		...(manifest.hostPermissions && manifest.hostPermissions.length > 0
			? { host_permissions: manifest.hostPermissions }
			: {}),
		...(optionsPage ? { options_ui: { page: optionsPage } } : {}),
		browser_specific_settings: {
			kiririn: kiririnSettings,
		},
	};
}
