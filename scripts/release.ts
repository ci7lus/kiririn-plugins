import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type KiririnPlugin, plugins } from "./plugins";

type KiririnVersionRange = {
	strict_min_version?: string;
	strict_max_version?: string;
};

type PluginUpdate = {
	version: string;
	update_link: string;
	update_hash: string;
	update_info_url: string;
	applications?: {
		kiririn: KiririnVersionRange;
	};
};

type UpdateManifest = {
	addons: Record<
		string,
		{
			updates: PluginUpdate[];
		}
	>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const updateManifestPath = resolve(repositoryRoot, "update.json");

async function readUpdateManifest(): Promise<UpdateManifest> {
	const contents = await readFile(updateManifestPath, "utf8");
	const manifest = JSON.parse(contents) as UpdateManifest;

	if (!manifest.addons || typeof manifest.addons !== "object") {
		throw new Error('update.json must contain an "addons" object.');
	}

	return manifest;
}

function getUnreleasedPlugins(updateManifest: UpdateManifest) {
	return plugins.filter((plugin) => {
		const publishedVersions =
			updateManifest.addons[plugin.manifest.identifier]?.updates ?? [];
		return !publishedVersions.some(
			(update) => update.version === plugin.manifest.version,
		);
	});
}

function createVersionRange(plugin: KiririnPlugin) {
	const range: KiririnVersionRange = {
		...(plugin.manifest.strictMinVersion
			? { strict_min_version: plugin.manifest.strictMinVersion }
			: {}),
		...(plugin.manifest.strictMaxVersion
			? { strict_max_version: plugin.manifest.strictMaxVersion }
			: {}),
	};

	return Object.keys(range).length > 0 ? range : undefined;
}

async function createPluginUpdate(
	plugin: KiririnPlugin,
	tag: string,
	repository: string,
	assetsDirectory: string,
): Promise<PluginUpdate> {
	const packageName = `${plugin.id}.kppx`;
	const packagePath = resolve(assetsDirectory, packageName);
	const packageContents = await readFile(packagePath);
	const packageHash = createHash("sha256")
		.update(packageContents)
		.digest("hex");
	const releaseBaseURL = `https://github.com/${repository}/releases`;
	const versionRange = createVersionRange(plugin);

	return {
		version: plugin.manifest.version,
		update_link: `${releaseBaseURL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(packageName)}`,
		update_hash: `sha256:${packageHash}`,
		update_info_url: `${releaseBaseURL}/tag/${encodeURIComponent(tag)}`,
		...(versionRange
			? {
					applications: {
						kiririn: versionRange,
					},
				}
			: {}),
	};
}

async function updateReleaseManifest(
	tag: string,
	repository: string,
	assetsDirectory: string,
) {
	const updateManifest = await readUpdateManifest();
	const unreleasedPlugins = getUnreleasedPlugins(updateManifest);

	if (unreleasedPlugins.length === 0) {
		throw new Error("No unreleased plugin versions were found.");
	}

	for (const plugin of unreleasedPlugins) {
		const identifier = plugin.manifest.identifier;
		const existingUpdates = updateManifest.addons[identifier]?.updates ?? [];
		const update = await createPluginUpdate(
			plugin,
			tag,
			repository,
			assetsDirectory,
		);

		updateManifest.addons[identifier] = {
			updates: [update, ...existingUpdates],
		};
	}

	await writeFile(
		updateManifestPath,
		`${JSON.stringify(updateManifest, null, "\t")}\n`,
	);

	console.log(
		`Updated update.json for: ${unreleasedPlugins
			.map((plugin) => `${plugin.id}@${plugin.manifest.version}`)
			.join(", ")}`,
	);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);

	switch (command) {
		case "targets": {
			const updateManifest = await readUpdateManifest();
			console.log(
				getUnreleasedPlugins(updateManifest)
					.map((plugin) => plugin.id)
					.join(","),
			);
			return;
		}
		case "update": {
			const [tag, repository, assetsDirectory = "release-assets"] = args;

			if (!tag || !repository) {
				throw new Error(
					"Usage: release:update <tag> <owner/repository> [assets-directory]",
				);
			}

			await updateReleaseManifest(
				tag,
				repository,
				resolve(repositoryRoot, assetsDirectory),
			);
			return;
		}
		default:
			throw new Error('Expected a command: "targets" or "update".');
	}
}

await main();
