import { init as sentryInit, setTag } from "@sentry/react";

// @ts-expect-error
const pluginId = __PLUGIN_ID__;
// @ts-expect-error
const version = __PLUGIN_VERSION__;
if (!pluginId || !version) {
	throw new Error("precondition failed");
}
// @ts-expect-error
const revision = __REVISION__;

export const initSentry = () => {
	sentryInit({
		dsn: "https://e52cc2d2865aa050c843c5c22d185ff4@o481625.ingest.us.sentry.io/4511358938185728",
	});
	setTag("plugin", pluginId);
	setTag("version", version);
	if (revision) {
		setTag("revision", revision);
	}
};
