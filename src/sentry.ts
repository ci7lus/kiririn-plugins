import {
	BrowserClient,
	defaultStackParser,
	getDefaultIntegrations,
	makeFetchTransport,
	Scope,
} from "@sentry/react";
import { Component, type ReactNode } from "react";

// @ts-expect-error
const pluginId = __PLUGIN_ID__;
// @ts-expect-error
const version = __PLUGIN_VERSION__;
// @ts-expect-error
const revision = __REVISION__;

export let scope: Scope | null = null;

export const initSentry = () => {
	if (!pluginId || !version) {
		return;
	}

	const integrations = getDefaultIntegrations({}).filter((di) => {
		return ![
			"BrowserApiErrors",
			"BrowserSession",
			"Breadcrumbs",
			"ConversationId",
			"GlobalHandlers",
			"FunctionToString",
		].includes(di.name);
	});

	const client = new BrowserClient({
		dsn: "https://e52cc2d2865aa050c843c5c22d185ff4@o481625.ingest.us.sentry.io/4511358938185728",
		transport: makeFetchTransport,
		stackParser: defaultStackParser,
		integrations,
	});

	scope = new Scope();
	scope.setClient(client);
	client.init();

	scope.setTag("plugin", pluginId);
	scope.setTag("version", version);
	if (revision) {
		scope.setTag("revision", revision);
	}

	window.addEventListener("error", (event: ErrorEvent) => {
		if (event.error instanceof Error) {
			captureException(event.error);
		}
	});

	window.addEventListener(
		"unhandledrejection",
		(event: PromiseRejectionEvent) => {
			const reason = event.reason;
			if (reason instanceof Error) {
				captureException(reason);
			} else {
				captureException(new Error(String(reason)));
			}
		},
	);
};

export function captureException(error: Error) {
	scope?.captureException(error);
}

interface ErrorBoundaryState {
	hasError: boolean;
}

export class SentryErrorBoundary extends Component<
	{ children: ReactNode },
	ErrorBoundaryState
> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(): ErrorBoundaryState {
		return { hasError: true };
	}

	componentDidCatch(error: Error) {
		captureException(error);
	}

	render() {
		if (this.state.hasError) {
			return null;
		}
		return this.props.children;
	}
}
