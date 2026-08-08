# nicojk ニコニコ公式生コメント取得（匿名受信）設計

## 目的

`nicojk` の生放送コメント取得について、現在の nx-jikkyo 経由に加えて、ニコニコ公式の生放送コメントを取得できるようにする。

第1段階では、ログイン・認証・コメント投稿を対象外とし、未ログイン状態でコメントを受信できるかどうかの検証と実装に集中する。

## 対象範囲

### 対象に含めるもの

- 生放送コメントの取得元をニコニコ公式または nx-jikkyo から選択できる設定
- デフォルトの生放送取得元をニコニコ公式にする
- `saya-definitions` の同梱データから公式ニコニコ放送ページを解決する
- NDGR の視聴WebSocket、View API、Segment APIを利用したコメント受信
- 受信したコメントを既存の `NiconicoComment` に変換する
- Safari/WebKitが自動生成するUser-Agent、Origin、Refererをそのまま利用する
- Safari実機での未ログイン状態の動作検証
- ニコニコ取得失敗時に、設定から nx-jikkyo へ切り替えられる状態表示

### 対象外とするもの

- ニコニコへのログイン・ログアウト
- Cookie APIやSafari本体のログイン状態の取得
- コメント投稿
- コメント投稿用のCSRFトークン、投稿キー、投稿WebSocketの調査
- `https://site.nicovideo.jp/jk/` のHTMLパースによる放送探索
- ニコニコ公式の過去ログ取得
- ニコニコ取得失敗時の自動的な nx-jikkyo への切り替え

## 前提と制約

### Kiririn WebExtension

プラグインはKiririn内のWebKit WebExtensionコンテキストで実行される。表示ページは overlay、panel、options ごとに分離されているため、既存実装と同じく `BroadcastChannel` と `navigator.locks` を使って接続リーダーを1つにする。

第1段階では background / Service Worker を追加せず、既存のページコンテキストで受信する。長時間接続やページ寿命に問題があることが実機で確認された場合に、後続段階でbackgroundへの分離を検討する。

### 外部定義

`src/plugins/nicojk/vendor/saya-definitions.json` をプラグインに同梱された唯一のチャンネル定義ソースとする。

現在の外部URL取得と `nicojk_definitions_cache_json` キャッシュは廃止し、静的JSONから読み込む。既存の `nicojk_definitions_cache_json` は新実装では参照しない。

チャンネル定義には次の情報を利用する。

- `nicojkId`: nx-jikkyo用の `jk...` ID
- `syobocalId`: 番組・シミュルキャスト解決用のID
- `nicoliveCommunityIds`: ニコニコ公式放送ページ解決用のID

## 放送ページの解決

各 `ResolvedCommentSource` に、対応する `nicoliveCommunityId` を保持できるようにする。

解決手順は次のとおり。

1. チャンネル定義の `nicoliveCommunityIds` の先頭要素を取得する。
2. `https://live.nicovideo.jp/watch/<id>` を `fetch` する。
3. 通常のHTTPリダイレクトを追従し、最終URLを確認する。
4. 最終URLがニコニコ生放送の視聴ページであれば、そのレスポンスHTMLから `webSocketUrl` を抽出する。
5. `nicoliveCommunityIds` がない場合、または現在放送中の `lv...` ページへ解決できない場合は、そのソースをニコニコでは利用不可とする。

`nicoliveCommunityIds` の2件目以降は第1段階では試さない。`https://site.nicovideo.jp/jk/` を使った探索は後続TODOとし、今回のコードからはアクセスしない。

放送ページが見つからない場合のエラーは、ネットワーク失敗、対象放送なし、ページ形式不明を区別できる内部エラーとして扱う。UIでは過度に詳細な通信情報を表示せず、「ニコニコ公式放送を特定できない」などの状態へ変換する。

## NDGRコメント受信

[NDGRClient](https://github.com/tsukumijima/NDGRClient) の受信手順をブラウザ向けに実装する。

### セッション開始

解決した視聴ページの `webSocketUrl` にWebSocket接続し、次のメッセージを送信する。

```json
{
  "type": "startWatching",
  "data": {
    "reconnect": false
  }
}
```

応答から `messageServer` の `viewUri` と、コメント時刻計算に必要な情報を取得する。ログイン由来の情報は第1段階では利用しない。

### View / Segment API

- `viewUri?at=now` を取得する
- Length-Delimited Protobufのフレームを読み取る
- ViewメッセージからセグメントURIを取り出す
- 各セグメントURIを取得する
- Segmentメッセージ内の `chat` / `overflowed_chat` をコメントへ変換する
- 次のセグメントを順次処理する

ストリーム読み取りは、ネットワークチャンク境界とProtobufフレーム境界が一致しないことを前提に、未消費バイトを保持して次回読み取りへつなぐ。

ProtobufスキーマはNDGRの実際のメッセージに必要なフィールドだけを扱う。未知のフィールドは無視し、サーバー側の追加フィールドで受信全体が失敗しないようにする。

### コメント変換

受信したコメントを既存の `NiconicoComment` に変換する。

- `content`: コメント本文
- `vpos`: NDGRのコメント時刻と `vposBaseTime` から算出
- `date` / `date_usec`: 受信メッセージの時刻
- `mail`: コマンド配列
- `user_id`: 匿名受信で取得できる値だけを利用
- `premium` / `anonymity`: 取得できない場合は既存形式の安全な既定値を使う
- `origin`: `ws`

既存のコメント蓄積、重複排除、最大1000件制限、overlay/panel間のブロードキャストを再利用する。

## コメントソース切り替え

生放送用設定に、次の値を追加する。

```ts
type LiveCommentSource = "niconico" | "nx-jikkyo";
```

デフォルトは `niconico` とする。既存設定の正規化処理を通してから保存・利用する。

- `niconico`: チャンネル定義から放送ページを解決し、NDGRで取得する
- `nx-jikkyo`: 現在の `CommentClient` を使う

ニコニコ公式取得の途中失敗は、自動的にnx-jikkyoへ変更しない。ユーザーが設定を変更した場合だけ、次回接続からnx-jikkyoを使う。

録画再生の `KakologManager` とnx-jikkyo過去ログ取得は、第1段階では変更しない。

## 権限と通信

認証を扱わないため、`cookies` 権限は追加しない。現在のKiririn本体が受理する `storage` のみを引き続き利用する。

ニコニコ関連の最低限のhost permissionを追加する。実際のリダイレクト先、視聴WebSocket、View/Segment URIのホストをPoCで確認し、必要最小限のmatch patternにする。

User-Agent、Origin、Referer、sec-ch-* はコードから設定しない。WebExtensionからのWebSocket接続でOriginが拒否される場合、偽装で解決しようとせず、PoC結果として実現上の制約を記録する。

HTTP取得は認証情報を意図的に利用しない設定で行う。WebSocketについてはブラウザが管理するハンドシェイクを利用し、Cookie値の読み取り・保存・手動ヘッダー生成は行わない。

## 失敗状態

少なくとも次の状態を内部的に区別する。

- 放送ページ解決中
- 放送ページ未解決
- WebSocket接続中
- NDGR受信中
- Protobuf解析エラー
- ブラウザ通信制約による接続失敗
- 番組終了・切断
- nx-jikkyo接続中

ニコニコが利用不可でも、nx-jikkyo設定時の既存動作は維持する。

## 検証計画

### 自動テスト

- `nicoliveCommunityIds[0]` から視聴URLを生成できる
- リダイレクト後の `lv...` URLを判定できる
- IDなしのチャンネルが `site.nicovideo.jp/jk/` へアクセスしない
- Length-Delimited Protobufを分割チャンクから正しく再構成できる
- NDGRコメントを `NiconicoComment` へ変換できる
- コメントソース設定の既定値と正規化が正しい
- `nx-jikkyo` 選択時に既存クライアントが使われる

### Safari実機PoC

未ログイン状態で、SafariのWeb Inspectorを使って次を確認する。

1. Community IDから生放送視聴ページへリダイレクトできる
2. `webSocketUrl` を取得できる
3. `startWatching` が受理される
4. View / Segment APIがSafariの標準ヘッダーで受理される
5. コメントを1件以上取得できる
6. セグメント切り替え後もコメント取得が続く
7. WebSocket切断後に再接続できる

失敗した場合は、HTTPステータス、WebSocket close code、Origin制約、HTML形式変更、Protobuf解析のどこで失敗したかを記録する。ログにCookie値や認証情報は出さない。

## 将来拡張

匿名受信が成立した後に、別設計として次を検討する。

- `site.nicovideo.jp/jk/` のパースによる放送探索
- background / Service Workerへの受信処理移行
- ログイン状態の判定
- コメント投稿
- 公式過去ログ取得
