# nicojk

- nicojk は kiririn アプリ向けのニコニコ実況表示プラグインです。
- kiririn は仕様に沿った HTML を作成することで再生内容に応じたコンテンツをオーバーレイできるプラグインを作成できます。
- kiririn のプラグインは `.kppx` Web Extension bundle として読み込まれます。
- 現在の仕様と bridge 型定義は [../../README.md](../../README.md) と [../../Plugin.d.ts](../../Plugin.d.ts) を参照してください。
## 仕様

- 主要な page component は `OverlayPage` `PanelPage` `OptionsPage` です。
- プラグインは `overlay.html` `panel.html` `options.html` の各 extension page から表示されます。
- 現在の表示面は `window.kiririn.getRuntimeInfo().displayAreaType` で判定します。
- 表示面は別 page として扱い、nicojk は `BroadcastChannel` と storage で疎結合に連携します。
- 設定は `browser.storage.local` を使います。
- `nicojk_definitions_cache_json` だけは `localStorage` に保存します。
  - この領域は 1 アプリあたり複数表示される可能性があります。
  - Player 領域ごとに再生コンテンツが異なり、Playable として取得できます。
  - nicojk では npm パッケージ niconicomments を使用してコメントのレンダラーの表示と、コンテンツに沿ったコメントの取得処理を行います。
  - 生放送では nx-jikkyo API (WebSocket) からコメントをリアルタイムに取得し emit します。
  - 録画では nx-jikkyo 過去ログ API からコメントを読み取り、再生位置に合わせて表示します。
- `PanelPage` は panel page で表示する一覧 UI です。
  - 現在 active な Player の取得したコメントを一覧表示し、必要に応じて NG する機能があります。
  - active なプレイヤーが切り替わり次第、対応する `OverlayPage` から表示情報とコメントを受け取ります。
  - 生放送の場合は直近最大 1000 件のコメントを、録画の場合は取得できた全てのコメントを受け取ります。
  - NG 機能は可能なかぎり早く反映します。
- `OptionsPage` は options page で表示する設定 UI です。
  - この領域は 1 アプリあたり 1 つ、または表示されないことがあるため、`OverlayPage` の動作に必須の処理を行いません。
  - nicojk プラグインの設定を行います。
  - NG ワード / NG ID / NG コマンドの指定ができます。
    - NG ワード: それが含まれているコメントを表示しない
    - NG ID: ID が一致するコメントを表示しない
    - NG コマンド: mail 配列に含まれている場合、mail 配列から除外する

## ルール

- 実装後、 `pnpm biome check --fix` と `pnpm build` を行ってください。
