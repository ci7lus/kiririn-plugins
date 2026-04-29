export interface NicoJKContext {
	jkId: string;
	channelName: string;
	startAt: number; // replay time=0 に対応する Unix timestamp
	endAt: number; // startAt + duration に対応する Unix timestamp
}
