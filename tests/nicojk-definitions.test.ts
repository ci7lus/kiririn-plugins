import assert from "node:assert/strict";
import test from "node:test";

import {
	loadDefinitions,
	type NicoJKChannelDefinition,
} from "../src/plugins/nicojk/definitions";
import { resolveCommentSources } from "../src/plugins/nicojk/source-resolver";

test("uses the bundled saya definitions", async () => {
	const definitions = await loadDefinitions();
	const nhk = definitions.find((definition) =>
		definition.serviceIds.includes(1024),
	);

	assert.equal(nhk?.networkId, 15);
	assert.equal(nhk?.nicoliveCommunityIds?.[0], "ch2646436");
});

test("propagates the first nicolive community id", async () => {
	const primaryChannel: NicoJKChannelDefinition = {
		type: "GR",
		name: "fixture",
		serviceIds: [9999],
		networkId: 15,
		nicojkId: 999,
		jkId: "jk999",
		nicoliveCommunityIds: ["ch2646436", "chignored"],
	};
	const sources = await resolveCommentSources({
		primaryChannel,
		baseStartAt: 1_700_000_000,
		duration: 60,
		isLive: true,
		queryTime: 1_700_000_000,
	});

	assert.equal(sources.primary.nicoliveCommunityId, "ch2646436");
});

test("does not invent an official id when the definition has none", async () => {
	const sources = await resolveCommentSources({
		primaryChannel: {
			type: "GR",
			name: "fixture",
			serviceIds: [9999],
			networkId: 15,
			nicojkId: 999,
			jkId: "jk999",
		},
		baseStartAt: 1_700_000_000,
		duration: 60,
		isLive: true,
		queryTime: 1_700_000_000,
	});

	assert.equal(sources.primary.nicoliveCommunityId, undefined);
});
