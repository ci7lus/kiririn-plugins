import { hostFetchText } from "./host-fetch";

const progLookupCache = new Map<string, Promise<SyobocalProgram[]>>();

interface ProgLookupParams {
	TID?: string;
	ChID?: string;
	Count?: string;
	Range: string;
	JOIN?: "SubTitles"[];
}

export interface SyobocalProgram {
	pid: number;
	tid: number;
	chId: number;
	count: number | null;
	subTitle: string;
	stSubTitle: string;
	progComment: string;
	startAt: number;
	endAt: number;
	rawStartAt: string;
	rawEndAt: string;
}

function pad(n: number) {
	return n.toString().padStart(2, "0");
}

function formatSyobocalDate(unixSeconds: number) {
	const jst = new Date((unixSeconds + 9 * 60 * 60) * 1000);
	return (
		[
			jst.getUTCFullYear(),
			pad(jst.getUTCMonth() + 1),
			pad(jst.getUTCDate()),
		].join("") +
		`_${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
	);
}

function parseSyobocalDate(value: string) {
	const normalized = value.replace(" ", "T");
	const parsed = new Date(`${normalized}+09:00`);
	return Math.floor(parsed.getTime() / 1000);
}

function parseProgramItem(element: Element): SyobocalProgram {
	const get = (tagName: string) =>
		element.querySelector(tagName)?.textContent || "";
	const rawStartAt = get("StTime");
	const rawEndAt = get("EdTime");
	const count = Number.parseInt(get("Count"), 10);

	return {
		pid: Number.parseInt(get("PID"), 10),
		tid: Number.parseInt(get("TID"), 10),
		chId: Number.parseInt(get("ChID"), 10),
		count: Number.isFinite(count) && count > 0 ? count : null,
		subTitle: get("SubTitle"),
		stSubTitle: get("STSubTitle"),
		progComment: get("ProgComment"),
		startAt: parseSyobocalDate(rawStartAt),
		endAt: parseSyobocalDate(rawEndAt),
		rawStartAt,
		rawEndAt,
	};
}

function parseProgLookupResponse(xml: string): SyobocalProgram[] {
	const document = new DOMParser().parseFromString(xml, "application/xml");
	if (document.querySelector("parsererror")) {
		throw new Error("Failed to parse Syobocal response");
	}

	const codeText =
		document.querySelector("ProgLookupResponse > Result > Code")?.textContent ||
		"0";
	const code = Number.parseInt(codeText, 10);
	if (code === 404) {
		return [];
	}
	if (code !== 200) {
		const message =
			document.querySelector("ProgLookupResponse > Result > Message")
				?.textContent || "Unknown Syobocal error";
		throw new Error(message);
	}

	return Array.from(
		document.querySelectorAll("ProgLookupResponse > ProgItems > ProgItem"),
	).map(parseProgramItem);
}

async function progLookup(
	params: ProgLookupParams,
): Promise<SyobocalProgram[]> {
	const key = JSON.stringify(params);
	const cached = progLookupCache.get(key);
	if (cached) {
		return cached;
	}

	const url = new URL("db.php", "https://cal.syoboi.jp/");
	url.searchParams.set("Command", "ProgLookup");
	for (const [key, value] of Object.entries(params)) {
		if (value == null) {
			continue;
		}
		url.searchParams.set(key, Array.isArray(value) ? value.join(",") : value);
	}

	const nextRequest = hostFetchText(url)
		.then((responseText) => parseProgLookupResponse(responseText))
		.catch((error) => {
			progLookupCache.delete(key);
			throw error;
		});

	progLookupCache.set(key, nextRequest);
	return nextRequest;
}

export function createSyobocalPointRange(unixSeconds: number) {
	const point = formatSyobocalDate(unixSeconds);
	return `${point}-${point}`;
}

export function createSyobocalRange(
	startUnixSeconds: number,
	endUnixSeconds: number,
) {
	return `${formatSyobocalDate(startUnixSeconds)}-${formatSyobocalDate(endUnixSeconds)}`;
}

function getSubTitlesJoin(count?: number | null): ProgLookupParams["JOIN"] {
	return count == null ? ["SubTitles"] : undefined;
}

export async function lookupChannelProgramAt(
	chId: number,
	atUnixSeconds: number,
): Promise<SyobocalProgram | null> {
	const programs = await progLookup({
		ChID: chId.toString(),
		Range: createSyobocalPointRange(atUnixSeconds),
		JOIN: ["SubTitles"],
	});

	return (
		programs.find(
			(program) =>
				program.startAt <= atUnixSeconds && atUnixSeconds < program.endAt,
		) ||
		programs.at(-1) ||
		null
	);
}

export async function lookupProgramsByTitleAt(
	tid: number,
	atUnixSeconds: number,
	count?: number | null,
): Promise<SyobocalProgram[]> {
	return progLookup({
		TID: tid.toString(),
		Count: count ? count.toString() : undefined,
		Range: createSyobocalPointRange(atUnixSeconds),
		JOIN: getSubTitlesJoin(count),
	});
}

export async function lookupProgramsByTitleBetween(
	tid: number,
	startUnixSeconds: number,
	endUnixSeconds: number,
	count?: number | null,
): Promise<SyobocalProgram[]> {
	return progLookup({
		TID: tid.toString(),
		Count: count ? count.toString() : undefined,
		Range: createSyobocalRange(startUnixSeconds, endUnixSeconds),
		JOIN: getSubTitlesJoin(count),
	});
}

export function normalizeSyobocalText(text: string | null | undefined) {
	return (text || "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(
			/[\s【】「」『』()（）<>〈〉《》・:：!！?？,，.。'"、-]|\[|\]/g,
			"",
		);
}

function getEpisodeLabels(program: SyobocalProgram) {
	return [program.subTitle, program.stSubTitle]
		.map(normalizeSyobocalText)
		.filter(Boolean);
}

export function programsDescribeSameEpisode(
	left: SyobocalProgram,
	right: SyobocalProgram,
) {
	if (left.tid !== right.tid) {
		return false;
	}

	if (left.count && right.count) {
		return left.count === right.count;
	}

	const leftLabels = getEpisodeLabels(left);
	const rightLabels = getEpisodeLabels(right);
	return leftLabels.some((leftLabel) =>
		rightLabels.some(
			(rightLabel) =>
				leftLabel === rightLabel ||
				leftLabel.includes(rightLabel) ||
				rightLabel.includes(leftLabel),
		),
	);
}

export function haveSimilarDuration(
	left: SyobocalProgram,
	right: SyobocalProgram,
	toleranceSeconds = 5 * 60,
) {
	const leftDuration = left.endAt - left.startAt;
	const rightDuration = right.endAt - right.startAt;
	const tolerance = Math.max(
		toleranceSeconds,
		Math.floor(Math.min(leftDuration, rightDuration) * 0.2),
	);
	return Math.abs(leftDuration - rightDuration) <= tolerance;
}
