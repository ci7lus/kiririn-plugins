import { execSync } from "node:child_process";
import { crx } from "@crxjs/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig } from "vite";
import {
	createWebExtensionBuildManifest,
	getPluginIdentifier,
	plugins,
} from "./scripts/plugins-manifest";
import { createZipPackagingPlugin } from "./scripts/vite-zip-plugin";

const kiririnPageTypes = ["overlay", "panel"] as const;

let revision: string | undefined;
try {
	revision = `"${execSync("git rev-parse --short HEAD").toString().trim()}"`;
} catch (error) {
	console.error(error);
}

const viteLogger = createLogger();

const filteredLogger = {
	...viteLogger,
	warn(message: string, options?: Parameters<typeof viteLogger.warn>[1]) {
		if (
			message.includes(
				'Both `rollupOptions` and `rolldownOptions` were specified by "crx:web-accessible-resources" plugin.',
			) ||
			message.includes(
				'Both `rollupOptions` and `rolldownOptions` were specified by "crx:content-scripts" plugin.',
			)
		) {
			return;
		}

		viteLogger.warn(message, options);
	},
};

function getKiririnPageInputs(
	targetPlugin: (typeof plugins)[number] | undefined,
) {
	if (!targetPlugin) {
		return undefined;
	}

	const inputs = kiririnPageTypes.flatMap((pageType) => {
		const entry = targetPlugin.entries[pageType];
		return entry ? [entry] : [];
	});

	return inputs.length > 0 ? inputs : undefined;
}

export default defineConfig(({ mode }) => {
	const targetPlugin = plugins.find((p) => p.id === mode);
	const kiririnPageInputs = getKiririnPageInputs(targetPlugin);

	return {
		customLogger: filteredLogger,
		plugins: [
			...(targetPlugin
				? [
						...(process.env.SENTRY_AUTH_TOKEN
							? [
									sentryVitePlugin({
										authToken: process.env.SENTRY_AUTH_TOKEN,
										org: process.env.SENTRY_ORG ?? "",
										project: process.env.SENTRY_PROJECT ?? "",
										release: {
											name: `${getPluginIdentifier(targetPlugin)}@${
												targetPlugin.manifest.version
											}`,
										},
										errorHandler(err) {
											console.warn(
												"[sentry-vite-plugin] Failed to upload source maps:",
												err.message,
											);
										},
										telemetry: false,
									}),
								]
							: []),
						createZipPackagingPlugin(targetPlugin),
						crx({
							manifest: createWebExtensionBuildManifest(
								targetPlugin,
							) as unknown as Parameters<typeof crx>[0]["manifest"],
							browser: "firefox",
						}),
					]
				: []),
			react(),
			tailwindcss(),
		],
		define: {
			__REVISION__: revision,
			__PLUGIN_ID__: JSON.stringify(
				targetPlugin ? getPluginIdentifier(targetPlugin) : "",
			),
			__PLUGIN_VERSION__: JSON.stringify(targetPlugin?.manifest.version ?? ""),
		},
		build: {
			emptyOutDir: false,
			outDir: targetPlugin ? `dist/${targetPlugin.id}` : "dist",
			sourcemap: process.env.SENTRY_AUTH_TOKEN ? "hidden" : false,
			...(kiririnPageInputs
				? {
						rollupOptions: {
							input: kiririnPageInputs,
						},
					}
				: {}),
		},
	};
});
