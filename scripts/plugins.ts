import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pluginsManifest from "./plugins-manifest.json" with { type: "json" };

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

type PluginDefinition = {
	id: string;
	entries: Partial<Record<ExtensionPageType, string>>;
	manifest: WebExtensionPluginManifest;
};

type PluginsManifest = {
	$schema: string;
	plugins: PluginDefinition[];
};

export type WebExtensionPlugin = PluginDefinition;
export type KiririnPlugin = WebExtensionPlugin;

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest: PluginsManifest = pluginsManifest;

export const plugins: KiririnPlugin[] = manifest.plugins.map((plugin) => ({
	...plugin,
	entries: Object.fromEntries(
		Object.entries(plugin.entries).map(([pageType, entry]) => [
			pageType,
			resolve(workspaceRoot, entry),
		]),
	),
}));

validatePlugins(plugins);

function validatePlugins(pluginList: KiririnPlugin[]) {
	const pluginIDs = new Set<string>();
	const identifiers = new Set<string>();

	for (const plugin of pluginList) {
		if (pluginIDs.has(plugin.id)) {
			throw new Error(`Duplicate plugin ID: ${plugin.id}`);
		}

		if (identifiers.has(plugin.manifest.identifier)) {
			throw new Error(
				`Duplicate plugin identifier: ${plugin.manifest.identifier}`,
			);
		}

		if (Object.keys(plugin.entries).length === 0) {
			throw new Error(
				`Plugin "${plugin.id}" must define at least one page entry.`,
			);
		}

		pluginIDs.add(plugin.id);
		identifiers.add(plugin.manifest.identifier);
	}
}

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
