# ニコニコ匿名ライブコメント取得 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nicojk` のライブコメント取得元を、デフォルトではログアウト状態のニコニコ公式へ切り替え、現行の nx-jikkyo を設定で選べる状態にする。放送ページのリダイレクト解決から NDGR のコメント受信までを Safari WebExtension の通常の `fetch`/WebSocket API で実装し、ログイン・投稿・`site.nicovideo.jp/jk/` のチャンネル探索は今回の対象外として明示的に未実行にする。

**Architecture:** saya-definitions の同梱データから `nicoliveCommunityIds[0]` をライブ取得ソースへ伝播する。ニコニコクライアントはコミュニティURLを `live.nicovideo.jp/watch/<id>` へリダイレクトし、最終HTMLの `embedded-data` から program ID・vpos基準時刻・message server WebSocket URL を抽出する。その後、NDGR の `startWatching` → `view?at=now` → Length-Delimited Protobuf segment の流れでコメントを既存の `NiconicoComment` へ変換する。nx-jikkyo とニコニコは共通のライブコメントクライアント境界で切り替え、既存のコメント表示・BroadcastChannel・重複排除・録画ログ取得は再利用する。

**Tech Stack:** TypeScript、React、WebExtension API、標準 `fetch`/`WebSocket`/`ReadableStream`/`BroadcastChannel`/`navigator.locks`、Node test runner、tsx、Biome、Vite、`@n-air-app/nicolive-comment-protobuf`。Protobufのmessage schema/decodeは公式TypeScriptパッケージへ委譲し、ネットワークチャンクをLength-Delimited frameへ分割する薄いreaderだけを実装する。

## Global Constraints

- 今回は匿名の受信だけを実装する。ログイン、Cookie取得、認証、コメント投稿、投稿UIは追加しない。
- ライブのデフォルト取得元は `niconico`、明示的に `nx-jikkyo` を選べるようにする。録画再生の過去ログ取得経路は変更しない。
- `src/plugins/nicojk/vendor/saya-definitions.json` を唯一の定義データ源にする。外部CDN fetch、localStorageキャッシュ、`nicojk_definitions_cache_json` の読み書きは削除する。
- `nicoliveCommunityIds` が空または存在しない場合は公式URLを推測して呼び出さず、そのソースを `unsupported` として扱う。`https://site.nicovideo.jp/jk/` のパースは今回実装しない。
- User-Agent、Origin、Referer、Cookieを偽装しない。fetchには `credentials: "omit"` を使い、host permissionは実際に必要なホストだけへ限定する。
- WebSocketとHTTPストリームは、既存のnx-jikkyoと同じくBroadcastChannelと`navigator.locks`でタブ間の重複接続を抑制する。新しいbackground/service workerは追加しない。
- NDGRの`Chat.vpos`は放送開始からの相対値として扱い、watch pageの`vposBaseTime`を加えて既存の絶対Unix時刻系`NiconicoComment`へ変換する。`date`、`date_usec`、`vpos`の関係を一貫させる。
- Protobuf messageの定義とdecodeは `@n-air-app/nicolive-comment-protobuf@2026.629.180145` を使用する。手書きのNDGR field mapやmessage decoderは追加しない。GitHub Packagesのscope registry設定が必要な場合はプロジェクトの`.npmrc`へ明示する。
- 実装ごとに失敗を握り潰さず、`disconnected`、`connecting`、`connected`、`error` を既存UIへ伝える。自動的にnx-jikkyoへフォールバックしない。
- 各タスクはテストを先に追加し、失敗を確認してから最小実装を入れ、テストと型検査を通してからコミットする。
- 既存のユーザー変更である `src/plugins/nicojk/vendor/` と `vendor/` の内容は変更・削除・無断ステージングしない。

---

## Task 1: 同梱定義とライブソースメタデータ

**Files:**
- Modify: `src/plugins/nicojk/definitions.ts`
- Modify: `src/plugins/nicojk/source-resolver.ts`
- Use unchanged: `src/plugins/nicojk/vendor/saya-definitions.json` (existing user-provided file)
- Create: `tests/nicojk-definitions.test.ts`

### Step 1: 同梱定義と伝播を検証するテストを書く

`definitions.ts` が同梱JSONを返すこと、`nicoliveCommunityIds[0]` が `ResolvedCommentSource.nicoliveCommunityId` へ伝播すること、IDがない定義では値が未設定になることを検証する。

```ts
test("uses the bundled saya definitions", async () => {
  const definitions = await loadDefinitions();
  const nhk = definitions.find((definition) => definition.serviceIds.includes(1024));

  assert.equal(nhk?.networkId, 15);
  assert.equal(nhk?.nicoliveCommunityIds?.[0], "ch2646436");
});

test("propagates the first nicolive community id", async () => {
  const primaryChannel: NicoJKChannelDefinition = {
    type: "GR",
    name: "fixture",
    serviceIds: [9999],
    networkId: 15,
    nicojkId: 999,
    jkId: "jk999",
    nicoliveCommunityIds: ["ch2646436", "chignored"],
  };
  const sources = await resolveCommentSources({
    primaryChannel,
    baseStartAt: 1_700_000_000,
    duration: 60,
    isLive: true,
    queryTime: 1_700_000_000,
  });
  assert.equal(sources.primary.nicoliveCommunityId, "ch2646436");
});

test("does not invent an official id when the definition has none", async () => {
  const sources = await resolveCommentSources({
    primaryChannel: {
      type: "GR",
      name: "fixture",
      serviceIds: [9999],
      networkId: 15,
      nicojkId: 999,
      jkId: "jk999",
    },
    baseStartAt: 1_700_000_000,
    duration: 60,
    isLive: true,
    queryTime: 1_700_000_000,
  });
  assert.equal(sources.primary.nicoliveCommunityId, undefined);
});
```

Import `NicoJKChannelDefinition` as a type for the two pure resolver fixtures. The first test must assert the actual bundled JSON rather than a duplicate fixture for the NHK entry; the resolver tests only verify propagation and the missing-ID behavior without contacting Syobocal.

### Step 2: テストが新しい仕様で失敗することを確認する

```bash
pnpm test -- tests/nicojk-definitions.test.ts
```

The test should fail because the current loader fetches the external URL and `ChannelDefinition`/`ResolvedCommentSource` do not yet contain the official community id.

### Step 3: `definitions.ts` を同梱JSONへ切り替える

Import `./vendor/saya-definitions.json` as a typed bundled value. Extend the definition shape with:

```ts
export interface ChannelDefinition {
  type: string;
  name: string;
  serviceIds: number[];
  networkId: number;
  nicojkId?: number;
  nicoliveCommunityIds?: string[];
  syobocalId?: number;
}
```

Remove `DEFINITIONS_URL`, `CACHE_KEY`, `CACHE_DURATION`, the `fetchJson` import, and all `localStorage` cache reads/writes. Keep `loadDefinitions()` asynchronous for caller compatibility, but return a normalized copy of the bundled array without network access.

### Step 4: `source-resolver.ts` に最初のコミュニティIDを追加する

Extend `ResolvedCommentSource` with:

```ts
nicoliveCommunityId?: string;
```

Populate it in the existing source builder with `definition.nicoliveCommunityIds?.[0]`. Do not use a later array item and do not derive an ID from JK ID, channel name, or `site.nicovideo.jp/jk/`.

### Step 5: テストと型検査を通してコミットする

```bash
pnpm test -- tests/nicojk-definitions.test.ts
pnpm type
git add src/plugins/nicojk/definitions.ts src/plugins/nicojk/source-resolver.ts tests/nicojk-definitions.test.ts
git commit -m "feat(nicojk): bundle saya definitions for live sources"
```

The commit must not include either untracked vendor directory wholesale; stage only the explicitly named files plus the already user-provided JSON only if Git reports it is required for the build artifact.

## Task 2: ライブコメント取得元設定

**Files:**
- Modify: `src/plugins/nicojk/ng-settings.ts`
- Modify: `src/plugins/nicojk/components/OptionsPage.tsx`
- Create: `tests/nicojk-settings.test.ts`

### Step 1: 設定の正規化テストを書く

Add a public type and normalizer with exact accepted values:

```ts
export const LIVE_COMMENT_SOURCE_VALUES = ["niconico", "nx-jikkyo"] as const;
export type LiveCommentSource = (typeof LIVE_COMMENT_SOURCE_VALUES)[number];

export function normalizeLiveCommentSource(value: unknown): LiveCommentSource {
  return value === "nx-jikkyo" ? "nx-jikkyo" : "niconico";
}
```

Test that missing and invalid values become `niconico`, that `nx-jikkyo` survives normalization, and that an existing settings object with unrelated values is not changed.

```ts
test("defaults live comments to anonymous niconico", () => {
  assert.equal(normalizeLiveCommentSource(undefined), "niconico");
  assert.equal(normalizeLiveCommentSource("unexpected"), "niconico");
});

test("allows explicit nx-jikkyo live comments", () => {
  assert.equal(normalizeLiveCommentSource("nx-jikkyo"), "nx-jikkyo");
});
```

### Step 2: 新しい設定が失敗することを確認する

```bash
pnpm test -- tests/nicojk-settings.test.ts
```

### Step 3: 設定型・デフォルト・保存経路を追加する

Add `liveCommentSource: LiveCommentSource` to `NicoJKSettings` and set `DEFAULT_SETTINGS.liveCommentSource` to `"niconico"`. Run the new normalizer from `normalizeSettings`, so values read from `browser.storage.local` cannot select an unknown mode. Preserve all existing normalization behavior and storage keys.

### Step 4: Options UIに切替を追加する

In the existing comment acquisition section, add a labeled `<select>` bound to `settings.liveCommentSource`:

```tsx
<select
  value={settings.liveCommentSource}
  onChange={(event) =>
    updateSettings({
      liveCommentSource: normalizeLiveCommentSource(event.target.value),
    })
  }
>
  <option value="niconico">ニコニコ（ログアウト状態）</option>
  <option value="nx-jikkyo">nx-jikkyo</option>
</select>
```

Explain in adjacent text that this applies only to live broadcasts; recorded playback continues to use nx-jikkyo. Use the existing settings update helper and styling rather than adding a new page or storage backend.

### Step 5: テスト・型検査を通してコミットする

```bash
pnpm test -- tests/nicojk-settings.test.ts
pnpm type
git add src/plugins/nicojk/ng-settings.ts src/plugins/nicojk/components/OptionsPage.tsx tests/nicojk-settings.test.ts
git commit -m "feat(nicojk): add live comment source setting"
```

## Task 3: ニコニコ放送ページの解決

**Files:**
- Create: `src/plugins/nicojk/niconico-watch-page.ts`
- Create: `tests/nicojk-watch-page.test.ts`

### Step 1: HTML解析とリダイレクトの契約をテストする

Define a narrow result type:

```ts
export interface NiconicoWatchPage {
  requestedUrl: string;
  finalUrl: string;
  programId: string;
  vposBaseTime: number;
  webSocketUrl: string;
}
```

Test an `embedded-data` fixture containing `program.nicoliveProgramId`, `program.vposBaseTime`, and `site.relive.webSocketUrl`. Also test that a non-`lv` final page, missing `embedded-data`, missing program ID, missing base time, and missing WebSocket URL all produce a typed error.

The fixture should represent HTML attribute escaping (`&quot;`) because the real value is in `data-props`. Keep HTML extraction in the pure `parseNiconicoWatchPageHtml` helper rather than relying on Node-only DOM APIs; the helper must decode the standard attribute entities before `JSON.parse`.

### Step 2: 失敗を確認する

```bash
pnpm test -- tests/nicojk-watch-page.test.ts
```

### Step 3: `live.nicovideo.jp/watch/<id>` を解決する

Implement these exported functions and types:

```ts
export type WatchPageFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function parseNiconicoWatchPageHtml(
  html: string,
  finalUrl: string,
): NiconicoWatchPage;

export async function resolveNiconicoWatchPage(
  communityId: string,
  fetchImpl: WatchPageFetch = globalThis.fetch,
): Promise<NiconicoWatchPage>;
```

Build the requested URL as `https://live.nicovideo.jp/watch/${encodeURIComponent(communityId)}` and call:

```ts
fetchImpl(requestedUrl, {
  redirect: "follow",
  credentials: "omit",
});
```

Require an HTTP success response, a final host of `live.nicovideo.jp`, and a final path matching `/watch/lv...`. Read the HTML, extract the `embedded-data` `data-props` JSON, and return all four resolved fields. Accept the page’s numeric or ISO-8601 representation of `program.vposBaseTime`, normalize it to Unix epoch seconds, and reject non-finite or non-positive values. Do not call `site.nicovideo.jp/jk/` when a community ID is absent; that absence is handled by Task 6 as an error with an `unsupported-community` reason.

### Step 4: テストと型検査を通してコミットする

```bash
pnpm test -- tests/nicojk-watch-page.test.ts
pnpm type
git add src/plugins/nicojk/niconico-watch-page.ts tests/nicojk-watch-page.test.ts
git commit -m "feat(nicojk): resolve niconico live watch pages"
```

## Task 4: NDGR Length-Delimited Protobufデコーダ

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create or modify: `.npmrc` with `@n-air-app:registry=https://npm.pkg.github.com` if the package manager needs the scoped registry to resolve the public package
- Create: `src/plugins/nicojk/ndgr-protobuf.ts`
- Create: `tests/nicojk-ndgr-protobuf.test.ts`

### Step 1: 分割入力と必要フィールドのテストを書く

Test a synthetic but wire-valid payload in chunks that split both the outer length varint and the message body. The decoder must emit complete frames only and retain incomplete bytes between `push` calls.

Use the official generated classes from `@n-air-app/nicolive-comment-protobuf` to encode fixtures and verify the decoded message shapes. Test the minimum NDGR messages used by the client:

```ts
interface SegmentDescriptor {
  uri: string;
}

interface NextView {
  at: number;
}

interface DecodedChat {
  content: string;
  vpos: number;
  no: number;
  rawUserId?: string;
  hashedUserId?: string;
  modifier?: {
    position?: string;
    size?: string;
    namedColor?: string;
    fullColor?: string;
    font?: string;
    opacity?: string;
  };
}
```

The test payloads must cover `ChunkedEntry.segment`, `ChunkedEntry.next.at`, `MessageSegment.uri`, `NicoliveMessage.chat`, `NicoliveMessage.overflowedChat`, and unknown fields/wire types. Use generated `encodeDelimited`/`decode` APIs for message fixtures; do not duplicate the upstream field numbers in application code. A malformed varint or impossible length must result in a decoder error rather than an infinite loop.

### Step 2: 失敗を確認する

```bash
pnpm test -- tests/nicojk-ndgr-protobuf.test.ts
```

### Step 3: 公式ProtobufパッケージとLength-Delimited readerを実装する

Add the pinned dependency `@n-air-app/nicolive-comment-protobuf@2026.629.180145` and use its generated namespace/classes, including `dwango.nicolive.chat.service.edge.ChunkedEntry`, `MessageSegment`, `ChunkedMessage`, and `dwango.nicolive.chat.data.NicoliveMessage`/`Chat`. The package is published to GitHub Packages; configure the `@n-air-app` scope registry without adding credentials or tokens to the repository. Do not vendor generated `dist/index.js` or reimplement the upstream schema.

Implement only a reusable `LengthDelimitedReader` around the official `decode`/`decodeDelimited` APIs. It must retain incomplete length varints and bodies between `push` calls, emit complete frame `Uint8Array`s, enforce a maximum frame length, and reject malformed varints or impossible lengths without looping. The application adapter may expose typed helpers that call the generated classes, but it must not duplicate upstream field numbers or manually parse message fields.

Use the generated classes to decode only the shapes required for segment scheduling and chat conversion:

- outer `ChunkedEntry`: generated `segment` or `next` oneof;
- generated `MessageSegment`: URI;
- generated `ReadyForNext`: next `at` value;
- generated `ChunkedMessage`: message payload;
- generated `NicoliveMessage`: `chat` and `overflowedChat` oneofs;
- generated `Chat`: content, vpos, raw/hashed user IDs, modifier, and no;
- generated `Modifier`: position, size, named/full color, font, and opacity.

Preserve generated `Long` values safely when reading `ReadyForNext.at` and `Chat.rawUserId`; convert them to strings or numbers only at the client boundary where the existing `NiconicoComment` contract requires it. Keep the upstream package as the source of truth for future field additions.

### Step 4: テスト・型検査を通してコミットする

```bash
pnpm test -- tests/nicojk-ndgr-protobuf.test.ts
pnpm type
git add package.json pnpm-lock.yaml .npmrc src/plugins/nicojk/ndgr-protobuf.ts tests/nicojk-ndgr-protobuf.test.ts
git commit -m "feat(nicojk): use official nicolive protobuf package"
```

## Task 5: ニコニコ匿名コメントクライアント

**Files:**
- Create: `src/plugins/nicojk/live-comment-client.ts`
- Create: `src/plugins/nicojk/niconico-comment-client.ts`
- Modify: `src/plugins/nicojk/comment-client.ts`
- Create: `tests/nicojk-niconico-comment-client.test.ts`

### Step 1: クライアント境界と偽WebSocket/ストリームのテストを書く

Create a shared interface so both live transports expose the same lifecycle:

```ts
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface LiveCommentClient {
  connect(source: ResolvedCommentSource, options?: { passive?: boolean }): void;
  disconnect(): void;
  getStatus(): ConnectionStatus;
  onStatusUpdate(callback: (status: ConnectionStatus) => void): () => void;
  onComment(callback: (comment: NiconicoComment) => void): () => void;
}
```

The test double must verify:

1. `connect` opens the resolved message-server WebSocket without custom headers.
2. The client sends exactly `{"type":"startWatching","data":{"reconnect":false}}` after the socket opens.
3. A `messageServer` response causes an initial `view?at=now` request.
4. A length-delimited segment with one chat produces an existing-shape `NiconicoComment`.
5. `overflowed_chat` is accepted as a comment source.
6. `vposBaseTime` is applied to `date`, `date_usec`, and absolute `vpos`.
7. Segment streams are consumed concurrently and a `next.at` value is used for the next view request.
8. `disconnect()` aborts fetches, closes WebSocket/BroadcastChannel, and ends with `disconnected`.
9. HTTP/WebSocket/parser failures produce `error` and do not silently switch to nx-jikkyo.

### Step 2: 失敗を確認する

```bash
pnpm test -- tests/nicojk-niconico-comment-client.test.ts
```

### Step 3: 共通境界へ nx-jikkyo を適合させる

Move or re-export the existing `ConnectionStatus` type from `live-comment-client.ts`. Change the existing `CommentClient.connect` signature to accept `ResolvedCommentSource` and use `source.jkId` internally. Keep its existing nx-jikkyo WebSocket URL, message parsing, passive lock behavior, and comment semantics unchanged. Make `CommentClient` implement `LiveCommentClient` so App can store either client in one map.

### Step 4: NDGR接続を実装する

`NiconicoCommentClient` must:

- resolve `source.nicoliveCommunityId` through `resolveNiconicoWatchPage`;
- set status to `connecting`, and return `error` for a source without a community ID;
- open the returned WebSocket URL with the browser’s default WebSocket constructor and no header options;
- wait for `messageServer` with a bounded timeout, read its `data.viewUri`, and fetch that exact URI with `?at=now` appended (or replace its existing `at` query parameter);
- read the HTTP response using `ReadableStreamDefaultReader<Uint8Array>` and `LengthDelimitedReader`;
- start each announced segment as an independent async consumer, retaining active segment promises until they finish;
- request the next view at the server-provided `next.at`, and abort all active work on disconnect;
- broadcast normalized comments over `nicojk_niconico_comments_${source.key}` and serialize only plain data;
- use `navigator.locks` with `nicojk_niconico_lock_${source.key}` so a passive tab receives broadcasts without opening the network transport;
- mark a comment’s origin as `"ws"` and convert modifier values into the existing `mail` string conventions used by `OverlayPage`;
- use the first available user identifier, otherwise the anonymous sentinel already expected by the UI, without attempting authentication.

Do not set `User-Agent`, `Origin`, `Referer`, or `Cookie`; do not add `credentials: "include"`; do not use a browser extension privileged request API.

### Step 5: テスト・型検査を通してコミットする

```bash
pnpm test -- tests/nicojk-niconico-comment-client.test.ts
pnpm type
git add src/plugins/nicojk/live-comment-client.ts src/plugins/nicojk/niconico-comment-client.ts src/plugins/nicojk/comment-client.ts tests/nicojk-niconico-comment-client.test.ts
git commit -m "feat(nicojk): add anonymous niconico comment client"
```

## Task 6: Appのソース切替とmanifest接続

**Files:**
- Modify: `src/plugins/nicojk/App.tsx`
- Modify: `scripts/plugins-manifest.json`
- Create: `tests/nicojk-live-source-selection.test.ts`

### Step 1: クライアントキーとモード切替のテストを書く

Add a pure helper in `live-comment-client.ts` or a nearby source utility:

```ts
export function getLiveClientKey(
  mode: LiveCommentSource,
  source: Pick<ResolvedCommentSource, "key">,
): string {
  return `${mode}:${source.key}`;
}
```

Test that the same source has distinct keys for `niconico` and `nx-jikkyo`, and that source callback routing uses `source.key` rather than only `jkId`.

### Step 2: 失敗を確認する

```bash
pnpm test -- tests/nicojk-live-source-selection.test.ts
```

### Step 3: Appのライブクライアント管理を一般化する

Change the live `clientsRef` map from a JK-ID-only map to `Map<string, LiveCommentClient>`. On each live-source refresh:

```ts
const mode = getSettings().liveCommentSource;
const clientKey = getLiveClientKey(mode, source);
const Client = mode === "niconico" ? NiconicoCommentClient : CommentClient;
```

Construct clients with the current `ResolvedCommentSource`, route comments only to players whose `liveSources` contain the same `source.key`, and calculate the source ordinal by `source.key`. Keep `scopeLiveComment`, the 1000-item cap, BroadcastChannel snapshots, passive tabs, and player status rendering intact.

When the setting changes, the next refresh must disconnect clients from the old mode, clear live comments associated with the old mode so comments from two transports cannot mix, and create clients under the new mode. A source without `nicoliveCommunityId` in `niconico` mode must receive `error` with an `unsupported-community` reason and must not trigger `site.nicovideo.jp/jk/`; users can choose nx-jikkyo to handle that use case.

Preserve the recorded playback branch and its 30-minute nx-jikkyo chunk loading exactly as-is.

### Step 4: host permissionsを追加する

Add the NicoNico hosts required by the actual request chain to the `nicojk` entry in `scripts/plugins-manifest.json`, initially including:

```json
"https://live.nicovideo.jp/*",
"https://mpn.live.nicovideo.jp/*"
```

During Safari verification, inspect the actual `webSocketUrl` host and add that exact host pattern if it is distinct. Keep the permission list explicit rather than using a broad `https://*.nicovideo.jp/*` wildcard. The build’s generated manifest must contain the final list.

### Step 5: テスト・整形・型検査を通してコミットする

```bash
pnpm test -- tests/nicojk-live-source-selection.test.ts
pnpm biome check --fix
pnpm type
git add src/plugins/nicojk/App.tsx scripts/plugins-manifest.json tests/nicojk-live-source-selection.test.ts
git commit -m "feat(nicojk): switch live comments between niconico and nx-jikkyo"
```

## Task 7: Safariで匿名取得の実動作を確認する

**Files:**
- No source change is required unless verification identifies a concrete host permission or parsing mismatch.
- Keep any temporary inspection notes outside the repository; do not commit cookies, tokens, HTML containing personal data, or WebSocket payload dumps.

### Step 1: 開発ビルドを作る

Run the repository validation commands first:

```bash
pnpm test
pnpm biome check --fix
pnpm build
```

If `pnpm build` fails with the known `listen EPERM .../tsx-*.pipe` sandbox error, rerun the same command through the approved escalation mechanism. Do not alter build scripts to avoid the socket.

### Step 2: SafariのWebExtensionを読み込む

1. Safariの「設定」→「詳細」で開発者向け機能とメニューバーの「開発」メニューを有効にする。
2. Kiririnの開発/debug用WebExtensionをSafariへ読み込む。
3. `nicojk` の設定を初期状態または「ニコニコ（ログアウト状態）」にする。Safariのニコニコアカウントはログアウト状態にして、認証情報をテスト条件から除外する。
4. `nicoliveCommunityIds[0]` がある現行放送チャンネルの再生ページを開く。
5. SafariのWeb Inspectorで、watch URLから`lv...`へのリダイレクト、`embedded-data`の解析、message-server WebSocket、view/segment fetchの順序を確認する。

### Step 3: 成功条件と失敗分類を記録する

成功条件は、ログインなしでライブコメントが表示され、既存のsource ordinal・NG・表示上限が機能し、録画再生が従来通りnx-jikkyoで動くこととする。

失敗時は次の分類で止める。

- `permission`: manifestのhost permission不足。Web Inspectorのブロック先を特定し、最小のホストパターンを追加する。
- `redirect/page`: 最終URLまたは`embedded-data`の形が想定と異なる。fixtureを保存せず、個人情報を除いた構造だけでテストを追加する。
- `websocket`: URL、接続、または`startWatching`応答が想定と異なる。ヘッダー偽装やログイン依存へ変更せず、プロトコル差分を確認する。
- `stream/protobuf`: frame境界、field番号、segment再生のどこで失敗したかを最小の合成テストへ落とし込む。
- `policy`: Safariが通常のWebExtension APIからの接続を拒否する。回避のためにUser-Agent/Origin/Cookieを偽装せず、実装可否と必要なユーザー設定を報告する。

## Task 8: 最終検証と引き渡し

**Files:**
- Review only: all files changed by Tasks 1–7

### Step 1: リポジトリ全体を検証する

```bash
pnpm test
pnpm type
pnpm biome check --fix
pnpm build
git status --short
```

Confirm that generated `.kppx` output includes `overlay.html`, `panel.html`, and `options.html`, and that no external saya-definitions URL or `nicojk_definitions_cache_json` reference remains:

```bash
rg -n "cdn.jsdelivr.net|nicojk_definitions_cache_json|site\.nicovideo\.jp/jk" src scripts tests
```

The only acceptable `site.nicovideo.jp/jk/` occurrence is a clearly labeled unsupported-path test or comment explaining that the lookup is intentionally not invoked in this phase; there must be no network call to it.

### Step 2: 最終差分をレビューする

Check the diff for:

- default `niconico` and explicit `nx-jikkyo` mode;
- static vendor definition loading;
- first community ID propagation;
- redirect-following watch-page resolver;
- no credentials or forbidden header mutation;
- segmented stream concurrency and cancellation;
- relative-to-absolute vpos conversion;
- old nx-jikkyo and recorded behavior preservation;
- no login/posting implementation;
- no accidental staging of unrelated user files.

### Step 3: 完了条件を報告する

Report the exact test/build commands and results, the Safari result or the first concrete blocking category, the final host permissions, and the setting path for switching back to nx-jikkyo. Do not claim anonymous NicoNico support is complete if Safari verification stopped at a policy or protocol failure.
