# Kiririn Plugins

## Repository Scope

- This repository builds Kiririn plugins as `.kppx` Web Extension bundles, not legacy single-HTML plugins.
- The current plugin spec lives in [src/Spec.md](src/Spec.md).
- The current bridge type definitions live in [src/Plugin.d.ts](src/Plugin.d.ts).
- `window.kiririn` is the app-specific bridge. Standard extension behavior should use normal WebExtension APIs and browser primitives.

## Build And Packaging

- Plugin definitions live in [scripts/plugins-manifest.ts](scripts/plugins-manifest.ts).
- Each plugin is `kind: "web-extension"` and declares `overlay`, `panel`, and/or `options` HTML entries.
- `pnpm build` runs [scripts/build.ts](scripts/build.ts), builds each plugin with Vite, and emits `dist/<plugin>.kppx`.
- Packaging rewrites built page paths to bundle-root `overlay.html`, `panel.html`, and `options.html`. Do not reintroduce single-page assumptions.

## Runtime Model

- Detect the current page with `window.kiririn.getRuntimeInfo().displayAreaType`.
- `displayAreaType` is `overlay`, `panel`, or `options`.
- `window.kiririn.getRuntimeInfo().playerID` is only populated on `overlay` pages.
- Panel pages that need an active player should use `getFocusedPlayerID()` and `onFocusedPlayerIDChange()`.
- Cross-page coordination should assume separate extension pages. Use storage, `BroadcastChannel`, or bridge callbacks instead of assuming a shared JS context.
- Network access should use normal `fetch` with the declared `host_permissions`.
- When persisting plugin data, use `browser.storage.local` only unless a task explicitly asks for another backend.

## nicojk Notes

- Shared entrypoint is [src/plugins/nicojk/main.tsx](src/plugins/nicojk/main.tsx); the same React app is loaded by `overlay.html`, `panel.html`, and `options.html`.
- [src/plugins/nicojk/components/OverlayPage.tsx](src/plugins/nicojk/components/OverlayPage.tsx) owns comment rendering and acquisition state.
- The panel UI is implemented by [src/plugins/nicojk/components/PanelPage.tsx](src/plugins/nicojk/components/PanelPage.tsx) and receives overlay snapshots over `BroadcastChannel` keyed by `playerID`.
- Live comments are capped at 1000 items. Recorded playback fetches 30-minute chunks, then rebuilds from the full set when loading completes.
- Settings values must be normalized via [src/plugins/nicojk/ng-settings.ts](src/plugins/nicojk/ng-settings.ts) before storing or using them.
- nicojk settings should use `browser.storage.local`, but `nicojk_definitions_cache_json` remains in `localStorage`.

## Validation

- For code changes in this repo, run `pnpm biome check --fix` and `pnpm build` before finishing when feasible.
