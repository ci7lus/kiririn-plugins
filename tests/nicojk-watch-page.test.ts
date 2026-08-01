import assert from "node:assert/strict";
import test from "node:test";
import {
	type NiconicoWatchPage,
	NiconicoWatchPageError,
	parseNiconicoWatchPageHtml,
	resolveNiconicoWatchPage,
} from "../src/plugins/nicojk/niconico-watch-page";

const FINAL_URL = "https://live.nicovideo.jp/watch/lv123456789";
const REQUESTED_URL = "https://live.nicovideo.jp/watch/co%2F123";
const EXPECTED_PAGE: NiconicoWatchPage = {
	requestedUrl: REQUESTED_URL,
	finalUrl: FINAL_URL,
	programId: "lv123456789",
	vposBaseTime: 1_700_000_000,
	webSocketUrl: "wss://example.test/watch/lv123456789",
};

function watchPageHtml(overrides: Record<string, unknown> = {}) {
	const props = {
		program: {
			nicoliveProgramId: "lv123456789",
			vposBaseTime: 1_700_000_000,
		},
		site: {
			relive: {
				webSocketUrl: "wss://example.test/watch/lv123456789",
			},
		},
		...overrides,
	};
	const escapedProps = JSON.stringify(props)
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&#39;");
	return `<html><body><div id="embedded-data" data-props="${escapedProps}"></div></body></html>`;
}

test("embedded-data の属性を復号して放送ページの4項目を抽出する", () => {
	assert.deepEqual(parseNiconicoWatchPageHtml(watchPageHtml(), FINAL_URL), {
		...EXPECTED_PAGE,
		requestedUrl: FINAL_URL,
	});
});

test("ISO-8601 の vposBaseTime を Unix epoch 秒へ正規化する", () => {
	const page = parseNiconicoWatchPageHtml(
		watchPageHtml({
			program: {
				nicoliveProgramId: "lv123456789",
				vposBaseTime: "2023-11-14T22:13:20.000Z",
			},
		}),
		FINAL_URL,
	);

	assert.equal(page.vposBaseTime, 1_700_000_000);
});

test("非有限または正でない vposBaseTime を拒否する", () => {
	for (const value of [0, -1, "not-a-date"]) {
		assert.throws(
			() =>
				parseNiconicoWatchPageHtml(
					watchPageHtml({
						program: {
							nicoliveProgramId: "lv123456789",
							vposBaseTime: value,
						},
					}),
					FINAL_URL,
				),
			(error: unknown) =>
				error instanceof NiconicoWatchPageError &&
				error.reason === "invalid-vpos-base-time",
		);
	}
});

for (const [name, html, reason] of [
	["final URL が lv ページでない", watchPageHtml(), "invalid-final-url"],
	["embedded-data がない", "<html></html>", "missing-embedded-data"],
	[
		"program ID がない",
		watchPageHtml({ program: { vposBaseTime: 1_700_000_000 } }),
		"missing-program-id",
	],
	[
		"base time がない",
		watchPageHtml({ program: { nicoliveProgramId: "lv123456789" } }),
		"missing-vpos-base-time",
	],
	[
		"WebSocket URL がない",
		watchPageHtml({ site: { relive: {} } }),
		"missing-websocket-url",
	],
] as const) {
	test(`${name} ときは typed error を返す`, () => {
		assert.throws(
			() =>
				parseNiconicoWatchPageHtml(
					html,
					name === "final URL が lv ページでない"
						? "https://live.nicovideo.jp/watch/co123"
						: FINAL_URL,
				),
			(error: unknown) =>
				error instanceof NiconicoWatchPageError && error.reason === reason,
		);
	});
}

test("HTTP成功・最終URL・HTMLを検証し、omit/follow で解決する", async () => {
	const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
	const response = new Response(watchPageHtml(), {
		status: 200,
		headers: { "content-type": "text/html" },
	});
	Object.defineProperty(response, "url", { value: FINAL_URL });

	const page = await resolveNiconicoWatchPage("co/123", async (input, init) => {
		calls.push([input, init]);
		return response;
	});

	assert.deepEqual(page, EXPECTED_PAGE);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.[0], "https://live.nicovideo.jp/watch/co%2F123");
	assert.deepEqual(calls[0]?.[1], {
		redirect: "follow",
		credentials: "omit",
	});
});

test("HTTP失敗を typed error にする", async () => {
	await assert.rejects(
		resolveNiconicoWatchPage(
			"co123",
			async () => new Response("error", { status: 500 }),
		),
		(error: unknown) =>
			error instanceof NiconicoWatchPageError && error.reason === "http-error",
	);
});
