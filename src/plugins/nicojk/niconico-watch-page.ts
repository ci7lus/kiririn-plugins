export interface NiconicoWatchPage {
	requestedUrl: string;
	finalUrl: string;
	programId: string;
	vposBaseTime: number;
	webSocketUrl: string;
}

export type NiconicoWatchPageErrorReason =
	| "unsupported-community"
	| "invalid-final-url"
	| "http-error"
	| "missing-embedded-data"
	| "invalid-embedded-data"
	| "missing-program-id"
	| "missing-vpos-base-time"
	| "invalid-vpos-base-time"
	| "missing-websocket-url";

export class NiconicoWatchPageError extends Error {
	override readonly name = "NiconicoWatchPageError";
	readonly reason: NiconicoWatchPageErrorReason;

	constructor(reason: NiconicoWatchPageErrorReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

export type WatchPageFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function fail(reason: NiconicoWatchPageErrorReason, message: string): never {
	throw new NiconicoWatchPageError(reason, message);
}

function decodeAttributeEntities(value: string) {
	return value.replace(
		/&(?:quot|amp|lt|gt|apos|#\d+|#x[\da-f]+);/gi,
		(entity) => {
			const namedEntity = (
				{
					"&quot;": '"',
					"&amp;": "&",
					"&lt;": "<",
					"&gt;": ">",
					"&apos;": "'",
				} as Record<string, string>
			)[entity.toLowerCase()];
			if (namedEntity) return namedEntity;

			const numericMatch = /^&#(?:x([\da-f]+)|([\d]+));$/i.exec(entity);
			if (!numericMatch) return entity;
			const codePoint = Number.parseInt(
				numericMatch[1] ?? numericMatch[2],
				numericMatch[1] ? 16 : 10,
			);
			return Number.isInteger(codePoint) && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: entity;
		},
	);
}

function findTagEnd(html: string, startAt: number) {
	let quote: '"' | "'" | undefined;
	for (let index = startAt; index < html.length; index += 1) {
		const character = html[index];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return index;
		}
	}
	return -1;
}

function getAttributeValue(element: string, attributeName: string) {
	const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(
		`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
		"i",
	).exec(element);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function findElementById(html: string, id: string) {
	const tagPattern = /<[A-Za-z][A-Za-z0-9:-]*\b/g;
	let match = tagPattern.exec(html);
	while (match) {
		const tagEnd = findTagEnd(html, match.index + match[0].length);
		if (tagEnd >= 0) {
			const element = html.slice(match.index, tagEnd + 1);
			if (getAttributeValue(element, "id")?.toLowerCase() === id) {
				return element;
			}
		}
		match = tagPattern.exec(html);
	}
	return undefined;
}

function extractEmbeddedDataProps(html: string) {
	const element =
		findElementById(html, "embedded-data") ??
		findElementById(html, "initial-state");
	if (!element) {
		fail(
			"missing-embedded-data",
			"The embedded-data or initial-state element is missing",
		);
	}

	const props = getAttributeValue(element, "data-props");
	if (props === undefined) {
		fail(
			"missing-embedded-data",
			"The embedded-data or initial-state data-props attribute is missing",
		);
	}

	return decodeAttributeEntities(props);
}

const NICONICO_WATCH_HOSTS = new Set([
	"live.nicovideo.jp",
	"sp.live.nicovideo.jp",
]);
const MILLISECONDS_EPOCH_THRESHOLD = 100_000_000_000;

function parseFinalUrl(finalUrl: string) {
	let url: URL;
	try {
		url = new URL(finalUrl);
	} catch {
		fail("invalid-final-url", "The final URL is not a valid URL");
	}

	if (
		!NICONICO_WATCH_HOSTS.has(url.hostname) ||
		!/^\/watch\/[^/]+$/.test(url.pathname)
	) {
		fail("invalid-final-url", "The final URL is not a nicolive watch page");
	}

	return url;
}

function normalizeVposBaseTime(value: unknown) {
	const rawEpochSeconds =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number.isNaN(Number(value))
					? Date.parse(value) / 1000
					: Number(value)
				: Number.NaN;
	// desktop の embedded-data は秒だが、iOS の initial-state は
	// JavaScript の Date と同じミリ秒で vposBaseTime を返す。
	const epochSeconds =
		rawEpochSeconds > MILLISECONDS_EPOCH_THRESHOLD
			? rawEpochSeconds / 1000
			: rawEpochSeconds;

	if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
		fail("invalid-vpos-base-time", "The vpos base time is invalid");
	}

	return epochSeconds;
}

interface EmbeddedProps {
	program?: {
		nicoliveProgramId?: unknown;
		vposBaseTime?: unknown;
	};
	site?: {
		relive?: {
			webSocketUrl?: unknown;
		};
	};
	pageContents?: {
		watchInformation?: {
			program?: {
				id?: unknown;
				vposBaseTime?: unknown;
			};
			playerParams?: {
				wsEndPoint?: {
					url?: unknown;
				};
			};
		};
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function hasValue(value: unknown) {
	return value !== undefined && value !== null && value !== "";
}

export function parseNiconicoWatchPageHtml(
	html: string,
	finalUrl: string,
): NiconicoWatchPage {
	parseFinalUrl(finalUrl);
	const propsJson = extractEmbeddedDataProps(html);
	let props: EmbeddedProps;
	try {
		props = JSON.parse(propsJson);
	} catch {
		fail("invalid-embedded-data", "The embedded-data JSON is invalid");
	}

	const programId = [
		props?.program?.nicoliveProgramId,
		props?.pageContents?.watchInformation?.program?.id,
	].find(isNonEmptyString);
	if (!programId) {
		fail("missing-program-id", "The nicolive program ID is missing");
	}

	const baseTime = [
		props?.program?.vposBaseTime,
		props?.pageContents?.watchInformation?.program?.vposBaseTime,
	].find(hasValue);
	if (!hasValue(baseTime)) {
		fail("missing-vpos-base-time", "The vpos base time is missing");
	}

	const webSocketUrl = [
		props?.site?.relive?.webSocketUrl,
		props?.pageContents?.watchInformation?.playerParams?.wsEndPoint?.url,
	].find(isNonEmptyString);
	if (!webSocketUrl) {
		fail("missing-websocket-url", "The WebSocket URL is missing");
	}

	return {
		requestedUrl: finalUrl,
		finalUrl,
		programId,
		vposBaseTime: normalizeVposBaseTime(baseTime),
		webSocketUrl,
	};
}

export async function resolveNiconicoWatchPage(
	communityId: string,
	fetchImpl: WatchPageFetch = globalThis.fetch,
): Promise<NiconicoWatchPage> {
	if (!communityId) {
		fail("unsupported-community", "A nicolive community ID is required");
	}

	const requestedUrl = `https://live.nicovideo.jp/watch/${encodeURIComponent(communityId)}`;
	const response = await fetchImpl(requestedUrl, {
		redirect: "follow",
		credentials: "omit",
	});
	if (!response.ok) {
		fail("http-error", `The watch page returned HTTP ${response.status}`);
	}

	const page = parseNiconicoWatchPageHtml(await response.text(), response.url);
	return { ...page, requestedUrl };
}
