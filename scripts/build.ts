import { execSync } from "node:child_process";
import { plugins } from "./plugins-manifest";

console.log("Starting build for all plugins...");

for (const plugin of plugins) {
	console.log(
		`\n--- Building plugin: ${plugin.manifest.name} (${plugin.id}) ---`,
	);
	try {
		execSync(`pnpm vite build --mode ${plugin.id}`, { stdio: "inherit" });
	} catch {
		console.error(`Failed to build ${plugin.id}`);
		process.exit(1);
	}
}

console.log("\nAll plugins built successfully.");
