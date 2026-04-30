export type NicoJKSourceKind = "primary" | "simulcast" | "replay";

export interface NicoJKSourceContext {
	key: string;
	jkId: string;
	channelName: string;
	kind: NicoJKSourceKind;
	startAt: number;
	endAt: number;
}

export interface NicoJKContext {
	jkId: string;
	channelName: string;
	startAt: number; // replay time=0 に対応する Unix timestamp
	endAt: number; // startAt + duration に対応する Unix timestamp
	sources: NicoJKSourceContext[];
}
