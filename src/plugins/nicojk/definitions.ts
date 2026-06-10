import { fetchJson } from "./host-fetch";

const DEFINITIONS_URL =
	"https://cdn.jsdelivr.net/gh/neneka/saya-definitions@master/definitions.json";
const CACHE_KEY = "nicojk_definitions_cache_json";
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 1 week

export interface ChannelDefinition {
	type: string;
	name: string;
	serviceIds: number[];
	networkId: number;
	nicojkId?: number;
	syobocalId?: number;
}

interface DefinitionsCache {
	timestamp: number;
	channels: ChannelDefinition[];
}

export interface NicoJKChannelDefinition extends ChannelDefinition {
	jkId: string | null;
}

function normalizeNetworkId(networkId: number) {
	return networkId > 31744 ? networkId >> 11 : networkId;
}

function toNicoJKChannelDefinition(
	channel: ChannelDefinition,
): NicoJKChannelDefinition {
	return {
		...channel,
		jkId: channel.nicojkId ? `jk${channel.nicojkId}` : null,
	};
}

async function loadDefinitions(): Promise<ChannelDefinition[]> {
	let channels: ChannelDefinition[] = [];

	const cached = localStorage.getItem(CACHE_KEY);
	if (cached) {
		try {
			const parsed: DefinitionsCache = JSON.parse(cached);
			if (Date.now() - parsed.timestamp < CACHE_DURATION) {
				channels = parsed.channels;
			}
		} catch (e) {
			console.error("Failed to parse definitions cache", e);
		}
	}

	if (channels.length > 0) {
		return channels;
	}

	try {
		const response = await fetchJson<{ channels: ChannelDefinition[] }>(
			DEFINITIONS_URL,
		);
		channels = response.channels;
		localStorage.setItem(
			CACHE_KEY,
			JSON.stringify({
				timestamp: Date.now(),
				channels,
			}),
		);
		return channels;
	} catch (e) {
		console.error("Failed to fetch definitions", e);
		return [];
	}
}

export async function getAllChannelDefinitions(): Promise<
	NicoJKChannelDefinition[]
> {
	const channels = await loadDefinitions();
	return channels.map(toNicoJKChannelDefinition);
}

export async function getChannelDefinition(
	serviceId: number,
	networkId: number,
): Promise<NicoJKChannelDefinition | null> {
	const channels = await loadDefinitions();
	const matched = channels.find(
		(channel) =>
			channel.serviceIds.includes(serviceId) &&
			channel.networkId === normalizeNetworkId(networkId),
	);

	return matched ? toNicoJKChannelDefinition(matched) : null;
}

export async function getJkInfo(
	serviceId: number,
	networkId: number,
): Promise<{ jkId: string; name: string } | null> {
	const matched = await getChannelDefinition(serviceId, networkId);
	if (matched?.jkId) {
		return { jkId: matched.jkId, name: matched.name };
	}

	return null;
}
