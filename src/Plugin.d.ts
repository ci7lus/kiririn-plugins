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

export interface PlayerPlaybackState {
	/** プレイヤー（ウィンドウ）の一意な ID */
	playerID: string;
	/** コンテンツの一意な ID */
	playableID: string;
	isPlaying: boolean;
	time: number; // seconds
	position: number; // 0.0 to 1.0
}

export interface Playable {
	/** プレイヤー（ウィンドウ）の一意な ID */
	playerID: string;
	/** コンテンツの一意な ID */
	id: string;
	title: string;
	subtitle?: string;
	/**
	 * 再生 time=0 に対応する現実時間の Unix timestamp。
	 * 未指定の場合は program.startAt を fallback として扱えます。
	 */
	initialNetworkTime?: number;
	isSeekable: boolean;
	length?: number;
	program?: Program;
	service?: Service;
}

/**
 * プラグインが表示されている領域の情報を表します。
 */
export interface DisplayArea {
	/** 表示されている場所の種類 */
	type: "playerOverlay" | "pluginSettings" | "pluginScreen";
	/** 紐付いているプレイヤー（ウィンドウ）の一意な ID */
	playerID?: string;
	/** 表示領域の幅 (px) */
	width: number;
	/** 表示領域の高さ (px) */
	height: number;
}

export interface KiririnBridge {
	/**
	 * 現在再生中のすべての Playable 情報を取得します。
	 * メタデータ（タイトル、画像、バックエンド情報など）の配列を返します。
	 */
	getPlayables(): Playable[];

	/**
	 * 再生中の Playable 一覧（メタデータ）の更新を購読します。
	 * 内容に変更があった場合のみ呼び出されます。
	 */
	onPlayablesChange(callback: (playables: Playable[]) => void): void;

	/**
	 * 現在再生中のすべてのプレイヤーの状態（再生中か、再生位置など）を取得します。
	 */
	getPlayerStatuses(): PlayerPlaybackState[];

	/**
	 * 再生状態の更新（1秒ごとの時間更新など）を購読します。
	 */
	onPlayerStatusesChange(
		callback: (statuses: PlayerPlaybackState[]) => void,
	): void;

	/**
	 * 現在フォーカスされている（操作対象の）プレイヤー（ウィンドウ）の ID を取得します。
	 */
	getFocusedPlayerID(): string | null;

	/**
	 * フォーカスされているプレイヤーの ID の更新を購読します。
	 */
	onFocusedPlayerIDChange(callback: (id: string | null) => void): void;

	/**
	 * プレイヤー（ウィンドウ）が閉じられたイベントを購読します。
	 */
	onPlayerClosed(callback: (playerID: string) => void): void;

	/**
	 * 指定したプレイヤーの Playable 情報を取得します。
	 * @param playerID getPlayables() などから取得できるプレイヤー ID
	 */
	getPlayable(playerID: string): Playable | null;

	/**
	 * 指定したプレイヤーの状態を取得します。
	 * @param playerID getPlayerStatuses() などから取得できるプレイヤー ID
	 */
	getPlayerStatus(playerID: string): PlayerPlaybackState | null;

	/**
	 * 現在の表示領域情報を取得します。
	 */
	getDisplayArea(): DisplayArea;

	/**
	 * 表示領域の更新（リサイズなど）を購読します。
	 */
	onDisplayAreaChange(callback: (area: DisplayArea) => void): void;

	/**
	 * ホスト（Swift）側にメッセージを送信します。
	 */
	// biome-ignore lint/suspicious/noExplicitAny: any
	sendMessage(type: string, data: any): void;
}

declare global {
	export interface Window {
		kiririn: KiririnBridge;
	}
}
