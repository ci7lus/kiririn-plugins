import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss(), viteSingleFile()],
	build: {
		rollupOptions: {
			input: {
				index: resolve(__dirname, "index.html"),
				playable: resolve(__dirname, "playable.html"),
			},
		},
	},
});
