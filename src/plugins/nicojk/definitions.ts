import sayaDefinitions from "./vendor/saya-definitions.json";

export interface ChannelDefinition {
	type: string;
	name: string;
	serviceIds: number[];
	networkId: number;
	nicojkId?: number;
	nicoliveCommunityIds?: string[];
	syobocalId?: number;
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

export async function loadDefinitions(): Promise<ChannelDefinition[]> {
	return sayaDefinitions.channels.map((channel) => ({
		...channel,
		serviceIds: [...channel.serviceIds],
		nicoliveCommunityIds: channel.nicoliveCommunityIds
			? [...channel.nicoliveCommunityIds]
			: undefined,
	}));
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
