/// <reference types="node" />

import { execFileSync, execSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	getPackagePath,
	type KiririnPlugin,
	plugins,
} from "./plugins-manifest";

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

function signAndVerifyPluginPackage(plugin: KiririnPlugin) {
	const signCertPath = process.env.SIGN_CRT_PATH;
	const signKeyPath = process.env.SIGN_KEY_PATH;

	if (!signCertPath && !signKeyPath) {
		return;
	}

	if (!signCertPath || !signKeyPath) {
		throw new Error(
			"SIGN_CRT_PATH and SIGN_KEY_PATH must both be set to sign plugin packages.",
		);
	}

	const packagePath = getPackagePath(plugin);
	console.log(`Signing ${plugin.id}: ${packagePath}`);
	execFileSync(
		"ziplac",
		[
			"sign",
			packagePath,
			packagePath,
			"--overwrite",
			"--cert",
			signCertPath,
			"--key",
			signKeyPath,
		],
		{ stdio: "inherit" },
	);

	console.log(`Verifying ${plugin.id}: ${packagePath}`);
	execFileSync("ziplac", ["verify", packagePath], { stdio: "inherit" });
}

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
		signAndVerifyPluginPackage(plugin);
	} catch (error) {
		console.error(error);
		console.error(`Failed to build ${plugin.id}`);
		process.exit(1);
	}
}

console.log("\nAll plugins built successfully.");
