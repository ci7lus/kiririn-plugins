import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const plugins = [
	{ name: "example", input: resolve(process.cwd(), "example.html") },
];

async function buildAll() {
	const distPath = resolve(process.cwd(), "dist");
	try {
		await fs.rm(distPath, { recursive: true, force: true });
	} catch {}

	for (const plugin of plugins) {
		console.log(`Building plugin: ${plugin.name}...`);
		await build({
			configFile: false,
			plugins: [react(), tailwindcss(), viteSingleFile()],
			build: {
				rollupOptions: {
					input: plugin.input,
				},
				emptyOutDir: false,
				outDir: "dist",
			},
		});
		console.log(`Plugin ${plugin.name} built successfully.`);
	}
}

buildAll().catch((err) => {
	console.error(err);
	process.exit(1);
});
