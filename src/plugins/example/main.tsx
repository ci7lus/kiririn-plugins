import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "../../index.css";
import { initSentry } from "../../sentry.ts";

initSentry();

// biome-ignore lint/style/noNonNullAssertion: vite
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
