/// <reference types="node" />

import { execSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { plugins } from "./plugins-manifest";

const requestedPluginIDs = new Set(process.argv.slice(2));
const targetPlugins =
	requestedPluginIDs.size > 0
		? plugins.filter((plugin) => requestedPluginIDs.has(plugin.id))
		: plugins;

if (targetPlugins.length === 0) {
	console.error(
		`No matching plugins found for: ${Array.from(requestedPluginIDs).join(", ")}`,
	);
	process.exit(1);
}

console.log("Starting build for selected plugins...");

async function cleanPluginDist(pluginID: string) {
	const distRoot = resolve(process.cwd(), "dist");
	const pluginDistDir = resolve(distRoot, pluginID);
	const packagePath = resolve(distRoot, `${pluginID}.kppx`);

	await rm(packagePath, { force: true });

	try {
		const entries = await readdir(pluginDistDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name === "manifest.json") {
				continue;
			}

			await rm(resolve(pluginDistDir, entry.name), {
				recursive: true,
				force: true,
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}

		throw error;
	}
}

for (const plugin of targetPlugins) {
	console.log(
		`\n--- Building plugin: ${plugin.manifest.name} (${plugin.id}) ---`,
	);
	try {
		await cleanPluginDist(plugin.id);
		execSync(`pnpm vite build --mode ${plugin.id}`, { stdio: "inherit" });
	} catch (error) {
		console.error(error);
		console.error(`Failed to build ${plugin.id}`);
		process.exit(1);
	}
}

console.log("\nAll plugins built successfully.");
