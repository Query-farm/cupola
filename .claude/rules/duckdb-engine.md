---
paths:
  - "src/lib/duckdb-*.ts"
  - "src/lib/shell-*.ts"
  - "src/lib/query-execution.ts"
  - "src/components/DuckDBShell.tsx"
  - "src/components/ShellBootScreen.tsx"
  - "tests/shell*.spec.ts"
  - "tests/editor-cancel.spec.ts"
  - "tests/query-cancel-surfaces.spec.ts"
---

# DuckDB-WASM engine, shell and bridges

## Lossless Arrow (`duckdb-worker-boot.ts`)
- `db.open({ arrowLosslessConversion: true })`. Without it UHUGEINT/BIT/TIME_TZ export lossy with no `ARROW:extension:metadata`, so `format.ts` handlers never fire.
- **Must be the config key, not `SET arrow_lossless_conversion = true`**: haybarn's exporter reads a C++ config field fixed at instantiation (`lib/src/webdb.cc`); `SET` changes a setting it never reads while `current_setting()` reports `true`. `arrow_output_version` is pinned the same way (`V1_0`). Guard: `.test_formats`.

## Terminal readiness (`shell-init.ts`)
- `terminal.runQuery` uses `term.paste()`, which xterm-readline only accepts inside `rl.read()` (else dropped or `Cannot read properties of undefined (reading 'inputType')`).
- Post-ready handoff resolves the prompt's catalog **before** hiding the boot overlay and publishing `runQuery`, so `readLoop()` reaches its first `rl.read()` synchronously. **Never add an `await` before that read** (input submitted in the gap is swallowed; Safari hits it constantly).
- Guard: `waitForShell` in `shell.spec.ts` requires the terminal to echo `.help`.

## Cancellation (`duckdb-worker-boot.ts`, haybarn-wasm ≥ 1.5.5-rc7 `getInterruptHandle`)
- Cancel writes `ClientContext::interrupted` via `Atomics.store` (a `cancelPendingQuery` message is read only after a whole poll). Only the query executor sets it, only while its own query holds the connection.
- **Every surface cancels by aborting the `AbortSignal` passed to `engine.query`/`queryPrepared`**: editor Stop, Ctrl+C in shell and `.ai`, Stop/Esc in AI chat and editor AI panel (agent loop passes the turn's signal to each tool call). No global "cancel whatever is running".
- Works at any thread count (the VGI-scan deadlock was fixed in engine rc7 and vgi).
- Builds without the flag fall back to `SET threads = 1`, restored on a separate connection (an aborted transaction refuses SET).
- Guard: `tests/editor-cancel.spec.ts` (Stop, engine free afterwards, thread restore).

## Bridges (`src/lib/shell-bridge.ts`)
- `engine` (owner `duckdb-worker-boot`): `query`, cancellation, boot phase/progress, `attached` barrier.
- `terminal` (owner `shell-init`): xterm instance, `runQuery`, `insertText`.
- `ui` (owner React): `openInEditor`, `navigateToSelection`, `showPerspective`/`showPreview`, `addQueryHistoryEntry`, memory-catalog refresh.
- `onQueryChange`/`notifyQueryChange` let features retry once `engine.query` exists.
- Per-catalog status on `engine`: `catalogStatuses` (`Map<alias, CatalogStatus>`, replaced on each change, written via `setCatalogStatus`), `defaultCatalog` (USE'd alias, requested alias, fell back?), subscribe with `onCatalogStatusChange`. `engine.catalogName` = default alias, null until its `USE`.
- Nullable slots and `?.()` guards are deliberate (late-bound).
- **`window.__bridge` is a deliberately FLAT facade for Playwright** (nine specs use old names); delegates via getters. Extend, don't reshape. `catalogStatuses()` returns plain objects; `defaultCatalog` the default state.

## Eager worker boot
- Worker created at CatalogApp mount, not when the shell opens. Pre-allocates SharedArrayBuffers for cancellation and OAuth.
- iPhone/iPad WebKit keeps the COI WASM and shared-memory interruption. `scripts/haybarn-mobile-runtime.mjs` generates a COI loader that prewarms four pthreads instead of eight; setting SQL `threads = 1` afterwards cannot prevent the original startup cost. Do not reduce the pool to one: instantiation opens a default four-thread database before `db.open` can apply our config, and a pool of one or two stalls in WebKit. The guarded one-character loader change preserves source-map positions and must be reviewed if the upstream initializer changes. Dev and asset staging use the same transformation. iPad desktop user agents are identified through `MacIntel` + touch points; layout selection remains based on viewport width.
- iOS sets `maximumThreads: 1` at open and a 256 MB DuckDB buffer-manager limit before loading extensions. This is not a cap on all browser memory. `shellExtensionsForRuntime` skips Spatial, Iceberg and DuckLake at iOS startup; explicit INSTALL/LOAD remains possible, but autoload stays disabled. Other platforms retain the complete startup list. `tests/ios-startup.spec.ts` checks both selections, COI isolation and mobile cancellation.
