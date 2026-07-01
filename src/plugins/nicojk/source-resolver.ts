import type { NicoJKChannelDefinition } from "./definitions";
import { getAllChannelDefinitions } from "./definitions";
import {
	haveSimilarDuration,
	lookupChannelProgramAt,
	lookupProgramsByTitleAt,
	lookupProgramsByTitleBetween,
	programsDescribeSameEpisode,
	type SyobocalProgram,
} from "./syobocal";

// ニコニコ実況サービス開始日
const RECORDED_REPLAY_LOOKUP_START_AT = Math.floor(
	new Date("2009-11-28T00:00:00+09:00").getTime() / 1000,
);
// CM がない AT-X などタイミングがズレるチャンネルは他チャンネルと混ぜず、同チャンネルの過去放送のみと照合する
const ISOLATED_REPLAY_CH_IDS = new Set([20]);

export type ResolvedSourceKind = "primary" | "simulcast" | "replay";

export interface ResolvedCommentSource {
	key: string;
	kind: ResolvedSourceKind;
	jkId: string;
	channelName: string;
	syobocalId?: number;
	startAt: number;
	endAt: number;
	/** vpos 計算の基点となる番組開始 unixtime（しょぼかる由来）。未設定時は startAt と同じ扱い */
	programStartAt?: number;
}

export interface ResolvedCommentSources {
	primary: ResolvedCommentSource;
	liveSources: ResolvedCommentSource[];
	replaySources: ResolvedCommentSource[];
}

function makeSourceKey(
	kind: ResolvedSourceKind,
	jkId: string,
	startAt: number,
	syobocalId?: number,
) {
	return [kind, jkId, syobocalId || "na", startAt].join(":");
}

function buildSource(
	channel: NicoJKChannelDefinition,
	kind: ResolvedSourceKind,
	startAt: number,
	endAt: number,
): ResolvedCommentSource | null {
	if (!channel.jkId) {
		return null;
	}

	return {
		key: makeSourceKey(kind, channel.jkId, startAt, channel.syobocalId),
		kind,
		jkId: channel.jkId,
		channelName: channel.name,
		syobocalId: channel.syobocalId,
		startAt,
		endAt,
		// programStartAt は resolveCommentSources で baseProgram 取得後に上書きされる
	};
}

function createChannelIndex(channels: NicoJKChannelDefinition[]) {
	const bySyobocalId = new Map<number, NicoJKChannelDefinition>();
	for (const channel of channels) {
		if (
			!channel.syobocalId ||
			!channel.jkId ||
			bySyobocalId.has(channel.syobocalId)
		) {
			continue;
		}
		bySyobocalId.set(channel.syobocalId, channel);
	}
	return bySyobocalId;
}

function isCandidateProgramMatch(
	baseProgram: SyobocalProgram,
	candidate: SyobocalProgram,
) {
	return (
		candidate.tid === baseProgram.tid &&
		programsDescribeSameEpisode(baseProgram, candidate) &&
		haveSimilarDuration(baseProgram, candidate)
	);
}

function dedupeSources(sources: ResolvedCommentSource[]) {
	const seen = new Set<string>();
	return sources.filter((source) => {
		const key = `${source.jkId}:${source.startAt}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

async function resolveLiveSources(
	primaryChannel: NicoJKChannelDefinition,
	baseProgram: SyobocalProgram,
	atUnixSeconds: number,
	channelIndex: Map<number, NicoJKChannelDefinition>,
) {
	const candidates = await lookupProgramsByTitleAt(
		baseProgram.tid,
		atUnixSeconds,
		baseProgram.count,
	);

	const sources = candidates
		.filter(
			(candidate) =>
				candidate.chId !== baseProgram.chId &&
				candidate.startAt <= atUnixSeconds &&
				atUnixSeconds < candidate.endAt &&
				isCandidateProgramMatch(baseProgram, candidate),
		)
		.map((candidate) => {
			const channel = channelIndex.get(candidate.chId);
			return channel
				? buildSource(channel, "simulcast", candidate.startAt, candidate.endAt)
				: null;
		})
		.filter((source): source is ResolvedCommentSource => !!source)
		.filter((source) => source.jkId !== primaryChannel.jkId);

	return dedupeSources(sources);
}

async function resolveRecordedReplaySources(
	_primaryChannel: NicoJKChannelDefinition,
	baseProgram: SyobocalProgram,
	channelIndex: Map<number, NicoJKChannelDefinition>,
) {
	const seenPrograms = new Set<string>([
		`${baseProgram.chId}:${baseProgram.startAt}:${baseProgram.endAt}`,
	]);
	const candidates = await lookupProgramsByTitleBetween(
		baseProgram.tid,
		RECORDED_REPLAY_LOOKUP_START_AT,
		Math.floor(Date.now() / 1000),
		baseProgram.count,
	);

	const isPrimaryIsolated = ISOLATED_REPLAY_CH_IDS.has(baseProgram.chId);

	const matches = candidates
		.filter(
			(candidate) =>
				isCandidateProgramMatch(baseProgram, candidate) &&
				(isPrimaryIsolated
					? candidate.chId === baseProgram.chId
					: !ISOLATED_REPLAY_CH_IDS.has(candidate.chId)),
		)
		.sort((left, right) => right.startAt - left.startAt)
		.map((candidate) => {
			const programKey = `${candidate.chId}:${candidate.startAt}:${candidate.endAt}`;
			if (seenPrograms.has(programKey)) {
				return null;
			}
			seenPrograms.add(programKey);

			const channel = channelIndex.get(candidate.chId);
			const source = channel
				? buildSource(channel, "replay", candidate.startAt, candidate.endAt)
				: null;
			return source ?? null;
		})
		.filter((source): source is ResolvedCommentSource => !!source);

	return dedupeSources(matches);
}

export async function resolveCommentSources(params: {
	primaryChannel: NicoJKChannelDefinition;
	baseStartAt: number;
	duration: number;
	isLive: boolean;
	queryTime: number;
}): Promise<ResolvedCommentSources> {
	const { primaryChannel, baseStartAt, duration, isLive, queryTime } = params;
	if (!primaryChannel.jkId) {
		throw new Error("Primary channel does not have a NicoJK id");
	}

	const primary = buildSource(
		primaryChannel,
		"primary",
		baseStartAt,
		baseStartAt + duration,
	);
	if (!primary) {
		throw new Error("Failed to build primary comment source");
	}

	if (!primaryChannel.syobocalId) {
		return {
			primary,
			liveSources: [],
			replaySources: [],
		};
	}

	const channelIndex = createChannelIndex(await getAllChannelDefinitions());
	const baseProgram = await lookupChannelProgramAt(
		primaryChannel.syobocalId,
		queryTime,
	);
	if (!baseProgram) {
		return {
			primary,
			liveSources: [],
			replaySources: [],
		};
	}

	// primary の vpos 計算基点をしょぼかる番組開始時刻に更新する
	const primaryWithProgramStart: ResolvedCommentSource = {
		...primary,
		programStartAt: baseProgram.startAt,
	};

	const liveSources = isLive
		? await resolveLiveSources(
				primaryChannel,
				baseProgram,
				queryTime,
				channelIndex,
			)
		: [];
	const replaySources = isLive
		? []
		: await resolveRecordedReplaySources(
				primaryChannel,
				baseProgram,
				channelIndex,
			);

	return {
		primary: primaryWithProgramStart,
		liveSources,
		replaySources,
	};
}
