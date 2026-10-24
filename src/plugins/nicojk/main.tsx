import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "./App.tsx";
import "../../index.css";
import { initSentry, SentryErrorBoundary } from "../../sentry.ts";
import { disposeSettingsSubscription, initializeSettings } from "./ng-settings";
import { startPageLifecycle } from "./page-lifecycle";

initSentry();

let root: Root | null = null;

function renderApp() {
	if (root) return;
	// biome-ignore lint/style/noNonNullAssertion: vite
	root = createRoot(document.getElementById("root")!);
	root.render(
		<StrictMode>
			<SentryErrorBoundary>
				<App />
			</SentryErrorBoundary>
		</StrictMode>,
	);
}

function unmountApp() {
	const currentRoot = root;
	root = null;
	currentRoot?.unmount();
}

startPageLifecycle(
	window,
	initializeSettings,
	renderApp,
	unmountApp,
	disposeSettingsSubscription,
);
