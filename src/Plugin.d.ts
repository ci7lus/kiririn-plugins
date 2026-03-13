export interface Genre {
	lv1: number;
	lv2?: number;
	name: string;
}

export interface Program {
	name: string;
	description: string;
	startAt: number; // Unix timestamp
	endAt: number; // Unix timestamp
	duration: number;
	eventId?: number;
	extended: [string, string][];
	genres: Genre[];
}

export interface ServiceType {
	value: number;
	description: string;
}

export interface Channel {
	id: string;
	type: string;
}

export interface Service {
	name: string;
	serviceId: number;
	networkId: number;
	type: ServiceType;
	channel?: Channel;
}

export interface Playable {
	id: string;
	title: string;
	program?: Program;
	service?: Service;
}

export interface DisplayArea {
	type: "playerOverlay" | "pluginSettings" | "pluginScreen";
	width: number;
	height: number;
}

export interface KiririnBridge {
	/**
	 * 現在再生中の情報を取得します。
	 */
	getPlayable(): Playable | null;

	/**
	 * 再生情報の更新を購読します。
	 */
	onPlayableUpdate(callback: (playable: Playable) => void): void;

	/**
	 * 現在の表示領域情報を取得します。
	 */
	getDisplayArea(): DisplayArea;

	/**
	 * 表示領域の更新（リサイズなど）を購読します。
	 */
	onDisplayAreaUpdate(callback: (area: DisplayArea) => void): void;

	/**
	 * ホスト（Swift）側にメッセージを送信します。
	 */
	// biome-ignore lint/suspicious/noExplicitAny: any
	sendMessage(type: string, data: any): void;
}

declare global {
	interface Window {
		kiririn: KiririnBridge;
	}
}
