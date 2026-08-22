export type NicoJKSourceKind = "primary" | "simulcast" | "replay";

export interface NicoJKSourceContext {
	key: string;
	jkId: string;
	channelName: string;
	kind: NicoJKSourceKind;
	miyouChannel?: string;
	startAt: number;
	endAt: number;
	interrupted?: boolean;
	chapterCorrection?: {
		offsetSeconds: number;
		enabled: boolean;
	};
}

export interface NicoJKContext {
	jkId: string;
	channelName: string;
	startAt: number; // time=0 に対応する Unix timestamp（initialNetworkTime、なければ program.startAt）
	endAt: number; // startAt + duration に対応する Unix timestamp
	/** primary のしょぼかる番組開始 unixtime。preroll = programStartAt - startAt */
	programStartAt: number;
	sources: NicoJKSourceContext[];
}
