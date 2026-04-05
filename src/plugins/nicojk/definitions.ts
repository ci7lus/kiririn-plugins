import axios from "axios";

const DEFINITIONS_URL =
	"https://cdn.jsdelivr.net/gh/neneka/saya-definitions@master/definitions.json";
const CACHE_KEY = "nicojk_definitions_cache_json";
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 1 week

interface ChannelDefinition {
	type: string;
	name: string;
	serviceIds: number[];
	networkId: number;
	nicojkId?: number;
}

interface DefinitionsCache {
	timestamp: number;
	channels: ChannelDefinition[];
}

export async function getJkInfo(
	serviceId: number,
	networkId: number,
): Promise<{ jkId: string; name: string } | null> {
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

	if (channels.length === 0) {
		try {
			const response = await axios.get(DEFINITIONS_URL);
			channels = response.data.channels;
			localStorage.setItem(
				CACHE_KEY,
				JSON.stringify({
					timestamp: Date.now(),
					channels,
				}),
			);
		} catch (e) {
			console.error("Failed to fetch definitions", e);
			return null;
		}
	}

	const matched = channels.find(
		(channel) =>
			channel.serviceIds.includes(serviceId) &&
			channel.networkId === (networkId > 31744 ? networkId >> 11 : networkId),
	);
	if (matched?.nicojkId) {
		return { jkId: `jk${matched.nicojkId}`, name: matched.name };
	}

	return null;
}
