import type { NiconicoComment } from "./comment-client";
import { buildMiyouCommentId } from "./comment-id";
import { fetchJson } from "./host-fetch";
import { getSettings, type NicoJKSettings } from "./ng-settings";
import type { ResolvedCommentSource } from "./source-resolver";

const MIYOU_BASE_URL = "https://miteru.digitiminimi.com/a2sc.php";

export interface MiyouComment {
	id: string;
	name: string;
	text: string;
	time: number;
	email: string;
	title: string;
}

type MiyouApiComment = {
	id?: unknown;
	name?: unknown;
	text?: unknown;
	time?: unknown;
	email?: unknown;
	title?: unknown;
};

type MiyouResponse =
	| "null"
	| {
			data?: {
				comments?: MiyouApiComment[];
			};
	  };

type MiyouAuthResponse = {
	token?: unknown;
	EC?: unknown;
	Edesc?: unknown;
};

let authCache: { key: string; token: string } | null = null;
let authPromise: { key: string; promise: Promise<string> } | null = null;

function asString(value: unknown) {
	if (typeof value === "string") return value;
	return typeof value === "number" && Number.isFinite(value)
		? String(value)
		: "";
}

function asFiniteNumber(value: unknown) {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function parseMiyouResponse(response: unknown): MiyouComment[] {
	if (response === "null" || typeof response !== "object" || response == null) {
		return [];
	}

	const data = (response as MiyouResponse & { data?: unknown }).data;
	if (typeof data !== "object" || data == null) {
		return [];
	}

	const comments = (data as { comments?: unknown }).comments;
	if (!Array.isArray(comments)) {
		return [];
	}

	return comments.flatMap((item, index) => {
		if (typeof item !== "object" || item == null) {
			return [];
		}

		const comment = item as MiyouApiComment;
		const time = asFiniteNumber(comment.time);
		const text = asString(comment.text);
		if (time == null || time <= 0 || text.length === 0) {
			return [];
		}

		return [
			{
				id: asString(comment.id) || `${time}:${index}`,
				name: asString(comment.name),
				text,
				time,
				email: asString(comment.email),
				title: asString(comment.title),
			},
		];
	});
}

function getCredentials(settings: NicoJKSettings) {
	const email = settings.miyouEmail.trim();
	if (!settings.miyouEnabled || email.length === 0 || !settings.miyouPassword) {
		return null;
	}

	return {
		email,
		password: settings.miyouPassword,
		key: `${email}\u0000${settings.miyouPassword}`,
	};
}

async function authenticate(credentials: {
	email: string;
	password: string;
}): Promise<string> {
	const response = await fetchJson<MiyouAuthResponse>(
		`${MIYOU_BASE_URL}/auth/moritapo`,
		{
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				email: credentials.email,
				password: credentials.password,
			}),
		},
	);
	const token = asString(response.token);
	if (!token || response.EC) {
		throw new Error(asString(response.Edesc) || "Miyou authentication failed");
	}
	return token;
}

async function getAuthToken(credentials: {
	email: string;
	password: string;
	key: string;
}) {
	if (authCache?.key === credentials.key) {
		return authCache.token;
	}
	if (authPromise?.key === credentials.key) {
		return authPromise.promise;
	}

	const promise = authenticate(credentials).then((token) => {
		authCache = { key: credentials.key, token };
		return token;
	});
	authPromise = { key: credentials.key, promise };
	try {
		return await promise;
	} finally {
		if (authPromise?.promise === promise) {
			authPromise = null;
		}
	}
}

export function clearMiyouAuth() {
	authCache = null;
	authPromise = null;
}

export function getMiyouSettingsSignature(settings: NicoJKSettings) {
	return JSON.stringify([
		settings.miyouEnabled,
		settings.miyouEmail,
		settings.miyouPassword,
	]);
}

export async function fetchMiyouComments(params: {
	channel: string;
	start: number;
	end: number;
}): Promise<MiyouComment[]> {
	const credentials = getCredentials(getSettings());
	if (!credentials || !params.channel || params.start >= params.end) {
		return [];
	}

	const token = await getAuthToken(credentials);
	const url = new URL(`${MIYOU_BASE_URL}/miyou/comments`);
	url.searchParams.set("channel", params.channel);
	url.searchParams.set("start", String(Math.floor(params.start * 1000)));
	url.searchParams.set("end", String(Math.floor(params.end * 1000)));

	const response = await fetchJson<MiyouResponse>(url, {
		headers: {
			"x-miteyou-auth-token": token,
		},
	});
	return parseMiyouResponse(response);
}

export function convertMiyouComment(
	comment: MiyouComment,
	source: ResolvedCommentSource,
	sourceOrdinal: number,
	primarySource: ResolvedCommentSource = source,
): NiconicoComment {
	const date = Math.floor(comment.time / 1000);
	const dateUsec = Math.floor((comment.time - date * 1000) * 1000);
	const timestamp = date + dateUsec / 1_000_000;
	const masterBaseTime = primarySource.programStartAt ?? primarySource.startAt;
	const relativeTime =
		sourceOrdinal > 0
			? timestamp - (source.programStartAt ?? source.startAt)
			: 0;
	const vpos = Math.floor(
		(sourceOrdinal > 0 ? masterBaseTime + relativeTime : timestamp) * 100,
	);
	const numericNo = Number.parseInt(comment.id, 10);

	return {
		id: buildMiyouCommentId({
			sourceKey: source.key,
			commentId: comment.id,
			time: comment.time,
		}),
		no: Number.isFinite(numericNo) ? numericNo : date,
		vpos,
		content: comment.text,
		date,
		date_usec: dateUsec,
		mail: comment.email ? [comment.email] : [],
		user_id: comment.id,
		premium: 0,
		anonymity: 1,
		origin: "miyou",
		sourceOrdinal,
	};
}
