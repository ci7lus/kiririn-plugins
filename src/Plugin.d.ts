/**
 * プラグインのマニフェスト情報は HTML の <meta> タグで宣言します。
 *
 * @example
 * <meta name="kiririn:version" content="1.0.0">
 * <meta name="kiririn:author"  content="作者名">
 * <meta name="kiririn:link"    content="https://example.com">
 * <meta name="kiririn:areas"   content="playerOverlay,pluginSettings">
 * <meta name="kiririn:id"      content="com.example.my-plugin">
 * <meta name="kiririn:contextId" content="my-plugin">
 *
 * kiririn:areas に指定可能な値: playerOverlay, pluginSettings, pluginScreen
 *
 * kiririn:id: プラグインの一意な識別子（任意）。
 *   指定すると「ファイルから上書き」時に異なる id のファイルへの更新を拒否し誤上書きを防ぎます。
 *
 * kiririn:contextId: WebView のオリジンに使われるサブドメインラベル（任意、小文字英数字とハイフン、1〜63文字）。
 *   未指定の場合は pluginID (UUID) の SHA-256 ハッシュの先頭 63 文字が使われます。
 */

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
	 * 指定したプレイヤーを再生します。playerID を省略した場合はフォーカス中のプレイヤーを操作します。
	 */
	play(playerID?: string): void;

	/**
	 * 指定したプレイヤーを一時停止します。playerID を省略した場合はフォーカス中のプレイヤーを操作します。
	 */
	pause(playerID?: string): void;

	/**
	 * 指定したプレイヤーの再生・一時停止を切り替えます。playerID を省略した場合はフォーカス中のプレイヤーを操作します。
	 */
	togglePlayPause(playerID?: string): void;

	/**
	 * 指定したプレイヤーのシーク位置を設定します。playerID を省略した場合はフォーカス中のプレイヤーを操作します。
	 * @param position シーク位置（0.0〜1.0）
	 */
	seek(position: number, playerID?: string): void;

	/**
	 * ホスト（Swift）側のネットワークスタック経由で HTTP(S) リクエストを送信します。
	 * 通常の fetch と違い、外部オリジンへのアクセスでもブラウザの CORS 制約を受けません。
	 */
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

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
