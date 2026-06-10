import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "../../index.css";
import { initSentry, SentryErrorBoundary } from "../../sentry.ts";
import { initializeSettings } from "./ng-settings";

initSentry();

function renderApp() {
	// biome-ignore lint/style/noNonNullAssertion: vite
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<SentryErrorBoundary>
				<App />
			</SentryErrorBoundary>
		</StrictMode>,
	);
}

void initializeSettings()
	.catch((error) => {
		console.error("Failed to load NicoJK settings before render", error);
	})
	.finally(() => {
		renderApp();
	});
