/// <reference types="node" />

import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import JSZip from "jszip";
import type { Plugin, ResolvedConfig } from "vite";
import {
	type ExtensionPageType,
	getPackagedPagePath,
	getPackagePath,
	type KiririnPlugin,
} from "./plugins-manifest";

const pageTypes = [
	"overlay",
	"panel",
	"options",
] as const satisfies readonly ExtensionPageType[];

async function collectArchiveFiles(
	directory: string,
	outputPath: string,
	rootDirectory = directory,
): Promise<Array<{ archivePath: string; filePath: string }>> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: Array<{ archivePath: string; filePath: string }> = [];

	for (const entry of entries) {
		const entryPath = resolve(directory, entry.name);
		if (entryPath === outputPath) {
			continue;
		}

		if (entry.isDirectory()) {
			files.push(
				...(await collectArchiveFiles(entryPath, outputPath, rootDirectory)),
			);
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		if (entry.name.endsWith(".map")) {
			continue;
		}

		files.push({
			archivePath: relative(rootDirectory, entryPath).replaceAll("\\", "/"),
			filePath: entryPath,
		});
	}

	return files;
}

async function flattenBuiltHtmlEntries(
	plugin: KiririnPlugin,
	bundleDir: string,
	workspaceRoot: string,
) {
	let movedEntryCount = 0;

	for (const entry of Object.values(plugin.entries)) {
		if (!entry) {
			continue;
		}

		const builtEntryPath = resolve(
			bundleDir,
			relative(workspaceRoot, entry).replaceAll("\\", "/"),
		);
		const flattenedEntryPath = resolve(bundleDir, basename(entry));

		if (builtEntryPath === flattenedEntryPath) {
			continue;
		}

		await rename(builtEntryPath, flattenedEntryPath);
		movedEntryCount += 1;
	}

	if (movedEntryCount > 0) {
		await rm(resolve(bundleDir, "src"), { recursive: true, force: true });
	}
}

async function rewriteBuiltManifest(plugin: KiririnPlugin, bundleDir: string) {
	const manifestPath = resolve(bundleDir, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		options_ui?: { page?: string };
		browser_specific_settings?: {
			kiririn?: {
				views?: Partial<
					Record<Exclude<ExtensionPageType, "options">, { page?: string }>
				>;
			};
		};
	};

	const optionsPage = getPackagedPagePath(plugin, "options");
	if (optionsPage && manifest.options_ui) {
		manifest.options_ui.page = optionsPage;
	}

	for (const pageType of pageTypes) {
		if (pageType === "options") {
			continue;
		}

		const page = getPackagedPagePath(plugin, pageType);
		const targetView =
			manifest.browser_specific_settings?.kiririn?.views?.[pageType];

		if (page && targetView) {
			targetView.page = page;
		}
	}

	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function createZipPackagingPlugin(plugin: KiririnPlugin): Plugin {
	let resolvedConfig: ResolvedConfig | undefined;

	return {
		name: "kiririn-plugin-zip-package",
		apply: "build",
		configResolved(config) {
			resolvedConfig = config;
		},
		async writeBundle() {
			if (!resolvedConfig) {
				return;
			}

			const bundleDir = resolve(
				resolvedConfig.root,
				resolvedConfig.build.outDir,
			);
			const packagePath = getPackagePath(plugin);
			await flattenBuiltHtmlEntries(plugin, bundleDir, resolvedConfig.root);
			await rewriteBuiltManifest(plugin, bundleDir);
			const zip = new JSZip();
			const files = await collectArchiveFiles(bundleDir, packagePath);

			for (const file of files) {
				zip.file(file.archivePath, await readFile(file.filePath));
			}

			const archive = await zip.generateAsync({
				type: "nodebuffer",
				compression: "DEFLATE",
				compressionOptions: { level: 9 },
			});

			await writeFile(packagePath, archive);
			resolvedConfig.logger.info(`Packed ${plugin.id}: ${packagePath}`);
		},
	};
}
