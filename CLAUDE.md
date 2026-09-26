# CLAUDE.md

## Project Overview

**Cupola** (`@query-farm/cupola`) — standalone web frontend for browsing VGI (Vector Gateway Interface) database catalogs. Connects to any VGI HTTP server and displays schemas, tables, views, and functions in a sidebar tree with detail panels. Includes an embedded DuckDB-WASM SQL shell, AI data analysis agent with charting, and pivot tables (Perspective). Built with Astro + React + ShadCN/UI + Tailwind CSS.

Designed to be shared across all VGI implementations (Python, TypeScript, Go). Hosted on a Cloudflare Worker with assets served from R2 (plus a Docker/Caddy kit for self-hosted Azure deployments). VGI servers redirect browsers to this frontend with `?service={url}`.

## Commands

```bash
# Install dependencies
bun install

# Development server (http://localhost:4321)
bun run dev

# Build for production
bun run build

# Preview production build
bun run preview

# Unit tests (tests/unit/*.test.ts)
bun run test

# Playwright e2e tests (tests/*.spec.ts)
bun run test:e2e

# Add a ShadCN component
bunx --bun shadcn@latest add <component> --yes

# Rebuild the vendored Perspective fork into public/perspective/
./build-perspective.sh                  # build + stage
./build-perspective.sh --stage-only     # re-stage an existing build

# Publish a new version (bump version in package.json first)
./publish.sh                  # prompt for commit message
./publish.sh "fix: whatever"  # use provided message
./publish.sh --skip-commit    # deploy only, no git
```

## Development

Always test against a running VGI server:
```bash
# Visit with service URL parameter
http://localhost:4321/?service=http://localhost:9003
```

The `?service=` parameter tells the frontend which VGI server to connect to. Without it, falls back to `window.location.origin`.

## URL Parameters

The app reads the following parameters from the URL. VGI servers issuing the redirect can populate any of them. All readers are consolidated in `src/lib/url-params.ts` (re-exported through `service.ts`, `theme.ts`, etc.).

### Query string (`?...`)

| Parameter | Purpose |
|-----------|---------|
| `service` | VGI server base URL. When absent, the welcome / connect page is shown instead of attempting to fetch a catalog. |
| `attach_options` | Raw SQL fragment spliced into the DuckDB `ATTACH` statement after `LOCATION` (e.g. `opt_string 'hello', opt_int64 42`). Takes precedence over the localStorage value, and is persisted via `saveRecentService` so a later visit without the param keeps it. An explicit empty value clears any saved options. |
| `ai_key` | Anthropic API key for the AI agent. Also accepted in the URL fragment (see below — fragments aren't sent to servers, so prefer that form). Merged into `settings.anthropicApiKey`, persisted to localStorage, and **stripped from the URL via `replaceState`** on first read so it doesn't linger in browser history or get sent as a referrer. Treat it as one-shot: passing the param overwrites any previously stored key. The query-string form takes precedence if both are set. |
| `sql` / `sql_z` | SQL for a shared query link. Accepted here for links a VGI server or a human composes server-side, but the Share button emits the fragment form (see below) — prefer that, since fragments aren't sent to servers. The query-string form takes precedence if both are set. |
| `theme` | URL of a theme JSON file (colors + optional logo + terminal theme). Cached in localStorage so subsequent loads can apply it before first paint (`src/lib/theme.ts`, pre-paint application in `src/layouts/Layout.astro`). |
| `fresh` | **Vestigial.** Formerly cleared a corrupted DuckDB session snapshot; session persistence was removed in the haybarn-wasm port. The reader (`getFreshFlag()` in `url-params.ts`) remains but has no callers. |

### URL fragment (`#...`)

| Fragment | Purpose |
|----------|---------|
| `#token=...&refresh_token=...&token_endpoint=...&client_id=...&client_secret=...&use_id_token=true` | OAuth tokens injected by a VGI server's auth redirect. The token is cached in memory and **only these auth keys** are stripped from the fragment — any other key=value pairs (e.g. `ai_key`) are preserved so they can be consumed by their own readers. Read by `src/lib/auth.ts`. |
| `#ai_key=...` | Anthropic API key. Equivalent to the `?ai_key=` query param but safer (fragments aren't sent to servers / referrer headers). Can be combined with the auth bundle in a single fragment. Stripped from the URL after consumption; other fragment keys are preserved. |
| `#sql=...` / `#sql_z=...` | SQL for a shared query link. Opens in a **new Query Editor tab, made active but not executed** — the recipient chooses when to run it. This is what the editor toolbar's Share button emits: a fragment never reaches the worker's request log, the redirect chain's `Location` headers, or an outbound `Referer`, and share links routinely carry literals (a table function's `api_key :=` argument, an email in a `WHERE`) the author never thought of as secret. `sql_z` is raw-deflate + base64url, used automatically past `AUTO_COMPRESS_THRESHOLD` (1500 chars) or forced via `buildShareQueryUrl({compress: true})`; a corrupt token decodes to null rather than throwing. Consumed and stripped by `consumeSharedSql()` (other fragment keys preserved); links are built by `buildShareQueryUrl()` in `src/lib/share-query.ts`. Because stripping the URL destroys the only copy, `consumeSharedSql()` stashes the decoded SQL in sessionStorage (`vgi-pending-share-sql`) and falls back to it when the URL has none; `CatalogApp` clears it only via `onPendingConsumed`, once the editor has taken it. Without that, an auth-protected service ate the query: `loadCatalog` 401s, `startLoginFlow` does a top-level `location.replace` to the IdP, and both the fragment and the React state holding the SQL are gone before the editor ever mounts. Connection context (`service`, `attach_options`) stays in the query string. **Not** a Sentry hiding place — the browser SDK captures `location.href` hash included, which is why `sentry-scrub.ts` scrubs both halves. |
| `#/schema/<s>/table/<t>` (and similar) | Selection routing — restores the sidebar selection on load and updates as the user navigates. Supports browser back/forward via `pushState` + `popstate` (`src/lib/navigation.ts`). |
| `#prefill=<service-url>` | Prefills the welcome page's `ConnectForm` with a URL (and any saved `attachOptions`) without auto-connecting. Used by the "Edit connection options" button on the attach-error modal. The hash is cleared after consumption. |

## Stack

- **Astro 6** — static site framework
- **React 19** — UI components via `client:load` islands
- **ShadCN/UI** — component library (Card, Table, Badge, Button, Input, Dialog, Switch, etc.)
- **Tailwind CSS v4** — styling via `@tailwindcss/vite` plugin
- **TanStack Table** — column sorting, filtering, expansion in ColumnsTable
- **xterm.js** — terminal emulator for the DuckDB SQL shell
- **DuckDB-WASM** (`@haybarn/haybarn-wasm`) — in-browser SQL engine with VGI extension
- **Perspective** — pivot table / data grid visualization. A **locally built fork**, vendored into `public/perspective/`; there is no `@perspective-dev/*` npm dependency (see "Vendored Perspective" below)
- **Vega-Lite** — AI agent chart rendering
- **Sentry** — error reporting + AI agent monitoring (`@sentry/astro` browser, `@sentry/cloudflare` worker)
- **vgi-typescript** (`vgi/client`) — browser-safe VGI client for Arrow IPC RPC
- **Bun** — package manager and runtime

## Architecture

```
src/
  pages/
    index.astro              # Main page, mounts CatalogApp
    sign-out.astro           # OAuth sign-out with IdP logout
    theme-builder.astro      # Live theme color editor at /theme-builder
    brand-preview.astro      # Logo/brand asset preview page
  layouts/Layout.astro       # HTML shell, fonts, favicon, pre-paint theme
  components/
    CatalogApp.tsx           # Top-level: fetches catalog, manages selection, routing
    DuckDBShell.tsx          # SQL shell panel: tabs, query history, Perspective/preview hosts
    ShellBootScreen.tsx      # Shell boot progress display
    Sidebar.tsx              # Tree view + search + settings
    Header.tsx               # Logo, catalog name, refresh, user info
    BrandMark.tsx            # Cupola logo mark
    ServiceSwitcher.tsx      # Service URL switcher with recent history + per-catalog identity
    ConnectBox.tsx           # DuckDB ATTACH snippet with copy
    SettingsModal.tsx        # Settings dialog (display, shell, AI config + telemetry opt-out)
    AskAIChat.tsx            # Claude AI chat panel with streaming, tool calls, charts
    SignOutPage.tsx          # Sign-out flow UI
    ErrorBoundary.tsx        # React error boundary (reports to Sentry)
    ThemeBuilder.tsx         # Live theme editor with color pickers
    tree-view.tsx            # Accordion-based tree (from mrlightful/shadcn-tree-view)
    content/                 # Detail panels: CatalogOverview, SchemaDetail, TableDetail,
                             #   ViewDetail, FunctionDetail, MacroDetail, ColumnsTable,
                             #   ColumnProfile, DataPreview, DataGrid, GeometryViewer,
                             #   MemoryCatalogOverview, Breadcrumb, ExampleQueries,
                             #   DescriptionSection, SqlCodeBlock, TagsTable, CatalogIcons,
                             #   CatalogIdentityCard, CatalogListItem, ColumnTypeBadge
    chat/                    # AI chat sub-components: ChatInput, ChatMessageUser/Assistant,
                             #   ChatMarkdown, ThinkingIndicator, SqlToolCallBlock,
                             #   AskUserBlock, QueryResultTable, VegaChartBlock,
                             #   MaximizedChartDialog, ChartDownloadMenu, chart-embed
    ui/                      # ShadCN generated components (do not edit manually)
  lib/
    # Core
    service.ts               # VgiClient wrapper: connect, fetch catalog/schemas/tables/stats
    url-params.ts            # Single source of truth for URL query/fragment readers
    auth.ts                  # JWT cookie/fragment token extraction
    tree.ts                  # Build TreeDataItem[] from CatalogData, selection↔ID mapping
    tree-expansion.ts        # Pure expand/collapse state logic for the sidebar tree
    navigation.ts            # URL hash routing, page title updates
    share-query.ts           # Shareable query links: ?sql= / ?sql_z= codec + builder
    settings.tsx             # Settings context + localStorage persistence
    utils.ts                 # cn() Tailwind class merge utility

    # DuckDB Shell
    shell-bridge.ts          # Typed global bridge singleton for cross-component messaging
    duckdb-worker-boot.ts    # Eager worker boot at CatalogApp mount (SABs, WASM transfer)
    duckdb-query.ts          # Shared DuckDB query helpers — every Arrow decode routes here
    shell-init.ts            # Imperative shell init: terminal, ATTACH flow, read loop
    shell-commands.ts        # Dot-command dispatcher (.mode, .maxrows, .perspective,
                             #   .preview, .download, .reset, .help; .ai is dispatched
                             #   in shell-init → shell-ai-mode)
    shell-input.ts           # Tab completion and Ctrl+R reverse history search
    shell-table-renderer.ts  # Terminal table rendering (box-mode, line-mode, cell formatting)
    shell-ai-mode.ts         # AI conversation loop in terminal with streaming ANSI
    table-ready.ts           # Wait until DuckDB can serve a given table path

    # Evidence report parameters (see "Evidence report parameters" below)
    evidence/                # parameters.ts, parameter-graph.ts, parameter-choices.ts,
                             #   parameter-url.ts, parameter-lint.ts, drill.ts, filter-summary.ts

    # Evidence PDF export (see "Evidence PDF export is Typst" below)
    evidence/typst/          # extract.ts (DOM → model), model.ts, emit.ts (→ Typst),
                             #   template.ts, charts.ts (ECharts → SVG), css-color.ts,
                             #   compiler.ts + load-compiler.ts (typst.ts), export-pdf.ts

    # AI Agent
    ai-agent.ts              # Claude agent: streaming SSE loop, tools (run_sql,
                             #   read_query_results, list_tables, describe_table, ask_user),
                             #   Sentry gen_ai span instrumentation
    ai-fetch.ts              # HTTP retry policy for the Anthropic API (429/529, backoff)
    ai-history.ts            # Conversation-history self-heal (dangling tool_use repair)
    ai-loop-guard.ts         # Repeated-tool-call loop breaker
    ai-tool-executor.ts      # Shared tool implementations across chat + terminal surfaces
    ai-telemetry.ts          # Sentry gen_ai attribute mapping + telemetry opt-out check
    query-results.ts         # Arrow→JSON result serialization + caching for the agent
    tool-input.ts            # Streamed tool_use input_json_delta parsing
    chart-rows-store.ts      # Session-scoped row cache for the render_chart tool
    pricing.ts               # Claude model pricing for cost estimation
    markdown-ansi.ts         # Streaming Markdown → ANSI for xterm rendering

    # Data & Types
    arrow-to-duckdb.ts       # Arrow type → DuckDB type name conversion
    column-profiler.ts       # Column distribution analysis (numeric, string, date, geometry)
    format.ts                # Value formatting for grids/terminals (dates, BigInt, geometry)
    function-info.ts         # Parse/format VGI function metadata (Arrow schemas):
                             #   per-arg name/type/kind + vgi_doc description and
                             #   vgi_default/choices/range/pattern constraints (the
                             #   same field metadata vgi_function_arguments() surfaces)
    geo-detect.ts            # Detect spatial columns suitable for map visualization
    tags.ts                  # Reserved vgi.* tag vocabulary + helpers (getTag with
                             #   deprecated-alias fallback, JSON parsers, category grouping,
                             #   display/AI filters)
    wkb.ts                   # WKB geometry parsing

    # Integrations
    duckdb-catalog.ts        # Introspect attached DuckDB databases for sidebar
    perspective-duckdb-handler.ts  # Perspective VirtualServerHandler backed by DuckDB WASM

    # Auth & Identity
    oauth-client.ts          # Browser OAuth 2.0 PKCE client (Entra/IdP)
    catalog-identity.ts      # Per-catalog identity fetching

    # Theme & Observability
    theme.ts                 # Theme loading from ?theme=<url>, localStorage caching
    sentry-scrub.ts          # Scrub secrets (token, refresh_token, client_secret, ai_key)
                             #   from URLs before they reach Sentry
    recent-services.ts       # Recently-connected service URLs (localStorage, max 10)
    node-stubs.ts            # Browser stubs for node:stream/zlib/crypto/fs
  styles/
    global.css               # Tailwind config, VGI color theme, ShadCN variables
worker/
  index.ts                   # Cloudflare Worker: versioned R2 serving, edge caching,
                             #   /latest redirect, Sentry (withSentry)
tests/
  unit/                      # bun:test unit tests (bun run test)
  *.spec.ts                  # Playwright e2e tests (bun run test:e2e)
                             #   perspective.spec.ts = static Arrow path
                             #   perspective-virtual-server.spec.ts = DuckDB-backed path
test-worker/                 # Python VGI worker serving the synthetic `cupola_test` catalog
                             #   (small/large/edge datasets, fault injection). Dev-only:
                             #   nothing outside dist/ is ever published. See its README.
.github/workflows/
  publish.yml                # Manual-dispatch CI publish (inactive until secrets are set)
```

## Key Design Decisions

**Browser-only imports**: The main `@query-farm/vgi-rpc` and `vgi` packages include Node.js code. The frontend uses:
- `vgi/client` — browser-safe entry point (no node:fs, node:os)
- `@query-farm/vgi-rpc/connect` — aliased in `astro.config.mjs` to the source client module

**A VGI schema is a path on the wire, a name in cupola** (`src/lib/vgi-catalog-types.ts`): VGI 0.29 replaced `SchemaInfo.name` with `path: string[]`, and every object's `schema_name` with `schema_path: string[]`, so the wire model admits nested schemas. Cupola does not, and neither does DuckDB — a schema is a single name in the hash route, in the `"schema"."table"` SQL the shell and editor generate, in the AI tool contract, and in the extension's own catalog mapping. The path is flattened once, at the RPC boundary in `fetchCatalog`, and **importing these types from `./vgi-catalog-types` (or `./service`) rather than `vgi/client` is what puts a module downstream of that boundary** — only `service.ts` and the boundary module itself should ever see the wire shape. The RPC calls still take the real `path`; flattening is for cupola's model, not the server. `join(".")` is exact for the one-element paths every server serves today; a nested catalog would render `outer.inner`, which is visibly wrong rather than silently truncated.

**Node stubs** (`src/lib/node-stubs.ts`): Apache Arrow's Node.js I/O modules reference `node:stream` etc. These stubs provide minimal class shells so `class X extends Readable` doesn't throw. They are aliased in `astro.config.mjs`.

**One Apache Arrow, everywhere**: application code imports Arrow **only** from `@query-farm/apache-arrow` — never bare `apache-arrow`, and never from a CDN. Arrow objects cross the boundary between cupola and the sibling repos (`vgi/client`'s `deserializeSchema` hands back `Field`s), so more than one build on the page means structurally-identical-but-nominally-distinct types and cross-version IPC bugs. Three copies used to ship at once: a phantom `apache-arrow@17` (imported by 10 modules but absent from `package.json`, resolving via a transitive hoist), `@query-farm/apache-arrow@21.1.1` from vgi-typescript's own `node_modules`, and `apache-arrow@18.1.0` fetched from jsdelivr at runtime by `DuckDBShell`. The hoist is `@haybarn/haybarn-wasm`, which declares `apache-arrow: ^17.0.0` (`bun.lock`) — **not** `@perspective-dev/client`, which never declared Arrow at all and is no longer a dependency. Keeping it to one requires **all three** of: the pinned `@query-farm/apache-arrow` dependency, `vite.resolve.dedupe` in `astro.config.mjs`, and the matching `paths` entry in `tsconfig.json` (the latter two must stay in sync, and the sibling sources resolve their own copy without them). Unit tests must import Arrow from the same package or they will build tables the code cannot decode. `@haybarn/haybarn-wasm` keeps its own internal `apache-arrow@17`; that is fine and separate — it exchanges only raw IPC bytes with us, never Arrow objects.

**Vendored Perspective** (`public/perspective/`, built by `./build-perspective.sh`): cupola does **not** consume `@perspective-dev/*` from npm. It loads a locally built fork carrying patches upstream does not have — DuckDB Arrow coercion for hugeint/uuid/timetz/interval/bignum/bit, all dictionary key widths, `Int64` preservation, and the `view_collapse`/`view_expand` handler-trait methods that `ViewTraversal` in `perspective-duckdb-handler.ts` depends on. The fork is `~/Development/perspective` branch `duckdb-type-support-v5.5`: upstream `v5.5.1` plus two commits (the coercion, and `Int64` preservation). A third v5.1-era patch — tz-bearing millisecond timestamps — was dropped in that rebase because upstream's `timestamp_to_millis` now strips the zone zero-copy, and upstream's `take`-based re-encoding replaced the fork's for dictionaries with non-`Int32` keys; `dict_str_value` was widened to every key width instead. The previous branch, `duckdb-type-support-v5` (on `v5.1.0`), is kept. To move to a newer upstream, cherry-pick those two commits onto the new tag and re-run the script.

Five things bite, all of which report the wrong cause:

- **The staging layout mirrors the npm package layout (`<pkg>/dist/cdn` + `<pkg>/dist/wasm`) and must not be flattened.** Each bundle finds its siblings relative to its own URL: `perspective-viewer.js` fetches `../wasm/perspective-viewer.wasm`, and `perspective.js` rewrites `.../client/dist/cdn/…` → `.../server/dist/wasm/…`, falling back to `../../../server/dist/wasm/…`. Flat, the viewer 404s (surfacing as `WebAssembly.compile(): BufferSource argument is empty`) and the server wasm is requested from the **origin root**. Cupola vendored these flat until the v5 upgrade, which is why it broke.
- **`Missing perspective-client.wasm` is a red herring.** `worker()` never fetches a client wasm — it reads `__wasm_module__` off the registered `<perspective-viewer>` class. The viewer ends in a top-level `await init_client(fetch(...))` which *swallows* a failed load ("Stage 0 wasm loading failed, skipping"), so the import still resolves and the element is silently never defined. Any problem loading `viewer/dist/wasm/perspective-viewer.wasm` surfaces as this error. **Check that file's URL first.**
- **`.gitignore` needs its `!public/perspective/**/dist/` negation.** The blanket `dist/` rule matches a directory named `dist` at any depth, so without it every vendored artifact is invisible to git — `git status` shows only the deletion of whatever was there before and none of the replacements, and a commit ships a broken app while all local tests stay green (Astro copies `public/` from disk regardless).
- **`viewer-charts` replaced `viewer-d3fc`** in the 4.5 plugin-API change, which also retired `viewer-openlayers`; both packages were deleted upstream. Loading the d3fc name 404s and rejects `ensurePerspectiveLoaded()`, taking out **both** Perspective paths.
- **Every shipped bundle still ends in `//# sourceMappingURL=<name>.js.map` even though `build-perspective.sh` deletes the `.map` files.** Devtools fetches that URL unconditionally on script load, regardless of whether the app ever references it — so a plain `.map` delete just turns "no source map" into a 404 in the console for `perspective.js`, `perspective-viewer.js`, `perspective-viewer-datagrid.js`, `perspective-viewer-charts.js`, and `perspective-server.worker.js` on every Perspective load. Harmless (Perspective itself works fine either way), but noisy enough to look like a real regression. The staging script strips the trailing `sourceMappingURL` comment line right after deleting the maps — if it reappears, the strip step didn't run against a newly-copied file.

Two build prerequisites fail with errors pointing elsewhere, so `build-perspective.sh` encodes them: `rust/perspective-client/src/rust/proto.rs` is **gitignored and generated** (a stale one gives ~56 "struct X has no field named Y" errors in files you never touched — regenerate with `PROTOC=… --features generate-proto`), and `PACKAGE` must include `metadata`, which emits the ts-rs bindings the client's `.d.ts` re-exports `Features` from (omit it and the Rust builds fine, then `tsc` fails with `Cannot find module '.../ts-rs/ColumnType.d.ts'`).

**Memory64 server binary.** `build-perspective.sh` sets `PSP_WASM64=1` so `rust/perspective-server/build.mjs` also produces `perspective-server.memory64.wasm` alongside the default wasm32 one (unset builds wasm32 only; `PSP_WASM64=only` would build *only* wasm64, dropping the wasm32 fallback needed for hosts without it — never use `only` here). `perspective.cdn.ts` already registers both and prefers wasm64 whenever `host_supports_memory64()` is true (Chrome 133+, Firefox 134+ by default at time of writing; Safari has no shipped support), raising the heap ceiling from 4GB to 16GB for large result sets with "some engine performance cost" per the fork's own registration doc comment. Before this, cupola never built the memory64 artifact at all, so every browser silently ran wasm32 regardless of what it supported — the failure mode was `Abort(): malloc of size N failed` for N around 2^31 once a result set approached wasm32's ceiling (a much rarer, later-stage cousin of the `arrow::Type::EXTENSION` abort in `perspective-extension-coerce.ts`'s doc comment — same C++ engine, different resource limit). A missing memory64 build isn't an error at either the build or the staging step — `select_server_wasm` falls back to wasm32 with a console warning, which is exactly the 404-then-fallback breadcrumb that looked alarming but was actually expected before this file existed.

**Two Perspective code paths, one container.** `ui.showPerspective(arrowBuffer)` loads a **static Arrow snapshot** (`perspectiveWorker.table()`) — driven by the shell's `.perspective` and the editor's Pivot → Snapshot. Selecting a table and opening the Perspective tab instead starts the **virtual server** (`VgiDuckDBHandler`), which compiles pivots to SQL against DuckDB-WASM; the editor's Run in Perspective and Pivot → Live view / Table use it too, over a TEMP view or table of the query (`ui.showPerspectiveQuery`, `src/lib/pivot-source.ts`). They share a DOM container and module-global worker but nothing else, and only the virtual server supports grouping. Each has its own spec (`perspective.spec.ts`, `perspective-virtual-server.spec.ts`, `perspective-query-pivot.spec.ts`); the virtual-server one had no coverage until v5 broke it.

**The virtual server serves each table one of two ways** (`PerspectiveServeMode` in `perspective-duckdb-handler.ts`), chosen when the table is mounted by probing for a `rowid` — DuckDB tables have one; views and VGI catalog tables do not. Each mode is its own handler and Perspective client, because Perspective reads features per client:

- **materialized** (Table-mode pivots, `memory` tables) — upstream's own DuckDB configuration: each layout is a `TEMP TABLE`, `rowid` orders unsorted grids, and split_by and natural-order windows work.
- **live** (VGI tables, live-view pivots) — each layout is a `TEMP VIEW`, so nothing is copied. `row_id_expr: "CAST(NULL AS INTEGER)"` orders unsorted grids by nothing (a bare `NULL` is refused: "ORDER BY non-integer literal has no effect"), `unordered: true` makes Perspective require an explicit order for windows, and split_by is off: it compiles to a `PIVOT` whose `ON` values are read from the data, which DuckDB refuses to store in a view. Upstream's view-based servers (Postgres, ClickHouse) make the same choices, and a two-pass filtered-aggregate split_by is the missing piece for all of them.

These are the 5.5 builder's own options (`create_entity`, `drop_entity`, `row_id_expr`), and they replaced three regex rewrites of the builder's SQL. The Perspective builder assumes a `rowid` in three places — unsorted flat order, split_by row numbering, and default window order — which is why a missing one mattered. The handler used to rename every column's `_` to `-`, a workaround for Perspective's builder deriving split_by names from DuckDB's `_`-joined `PIVOT` output (perspective-dev/perspective#3187); upstream fixed that in 5.0, so names now pass through unchanged. The handler's scratch objects live in `temp.main`: a view in `memory` binds the names inside it against the memory catalog, so it could not see through a TEMP pivot source. Every query the handler runs is logged to the console as `[perspective sql] <step> · <ms> · <size or error>`.

**Static Perspective snapshots are owned per container, and freed by ejecting first** (`loadPerspective` / `releasePerspective` in `DuckDBShell.tsx`). `viewer.load(client)` takes no ownership of a Table, so cupola must delete each snapshot itself — and an immediate `table.delete()` while the viewer still holds a View aborts server-side with "Cannot delete table with views". `Table.delete()` consumes its wasm-bindgen handle either way, so a failed delete cannot be retried: the table simply stays in the Perspective heap. That is what every reload used to do, with the error swallowed as "already gone", and the reference lived in one module-global slot shared by the shell tab and every report Perspective block. So: `viewer.eject()` first (drops the Views), then `delete({ lazy: true })` as a backstop, tracked in a `WeakMap` keyed by host container; loads for one container are serialized and a superseded load resolves `false` without touching its buffer; hosts call `releasePerspective` on unmount. The old behaviour is what killed the tab on a 400k-row report Perspective block — each dataset re-run (the AI builder re-runs on every `upsert_report_block`) stacked another full copy in the renderer process. `tests/report-perspective-stress.spec.ts` asserts exactly one `cupola-static-*` table survives each re-run.

**Report results do not carry JS rows** (`ReportsWorkspace.tsx`): a `DatasetResult` holds the decoded Arrow `table` plus the `arrowBuffer` it views over, and row objects come from `datasetRows(table)` — built on first use, memoized per table in a `WeakMap` so consumers keep a stable array identity. Rows are the heaviest form a result takes, and Perspective, table and map blocks never read them; `reportDatasetNeedsRows()` (`reports/execution.ts`) decides whether a run materializes them up front (still timed as decode) or skips them. Perspective blocks ingest `arrowBuffer` directly — re-serializing the decoded table cost two more copies per load and went through plain `tableFromIPC`, which drops dictionaries.

**Report block drags are placed by cupola, not react-grid-layout** (`reports/grid-compactor.ts`, `reportDragLayout` in `reports/layout.ts`). RGL resolves a drag inside `moveElement` by pushing whatever the block touches downward, before the compactor runs. In grouped reports (no compaction, so heading rows survive) a block dragged down shoved its neighbor ahead of it and could never pass; with vertical compaction it passed only after travelling the neighbor's full height. The report compactor sets `allowOverlap: true` — the only way to make `moveElement` hand the raw pointer cell straight to `compact()` — and, between `onDragStart` and `onDragStop`, tries every reading-order slot from the drag-start snapshot and takes the one landing the block nearest the pointer (ties: least disturbance, then nearest original slot). Other blocks keep their columns and the space above them, and group heading rows are recomputed, so an untouched drag reproduces the layout exactly. Outside a drag it is the old compactor verbatim. `onDragStop` must end the session: RGL runs the final `compact()` *before* calling it. `tests/report-drag.spec.ts` drives real mouse drags for both modes.

**Evidence's table metadata is Cupola's, keyed `catalog.schema.table`** (`src/lib/evidence/catalog-metadata.svelte.ts`, `catalog-names.ts`). Evidence has no plain DuckDB mode. Its `motherduck` warehouse mode is the DuckDB dialect (standard SQL, nothing MotherDuck-specific), and Cupola keeps it for SQL generation. Its catalog loader keys tables `schema.table`, though, and Cupola can attach several catalogs at once (each VGI catalog, `memory`, `temp`), so same-named tables overwrote each other's columns. A catalog-qualified reference like `demo.daily_orders` also matched nothing, which is why `dimension_grid` said "No dimensions detected". `CupolaMetadata` overrides `load()` and `getTable()`. Every table is registered once under its full name, and shorter names resolve in DuckDB's own order: bare names through temp, then the default database's schema; `x.table` first as a schema of the searched catalogs, then as catalog `x`'s `main`. The metadata never names a table DuckDB wouldn't reach with the same reference. Introspection goes straight to the engine (`readRowsOrThrow`), not through the report's query service, because the catalog belongs to the session: stopping a report must not cancel it.

**A query cancelled by a stopped or superseded refresh is not a report problem** (`HaybarnQueryService.execute`). It still returns its error to the component, but it isn't logged. Before, every query in flight when a refresh stopped, including Evidence's own catalog and `__describe__` probes, surfaced as "Report refresh stopped." in the problems panel, which made `evidence-authoring.spec.ts` fail most runs.

**Evidence PDF export is Typst, fed from the rendered DOM** (`src/lib/evidence/typst/`, the **Export PDF** button beside **Print report**). `extract.ts` walks the live report (the preview's shadow root, `[data-markdoc-content]`) into a plain document model (`model.ts`); `emit.ts` turns that into Typst against the template in `template.ts`; typst.ts compiles it to PDF in the browser. Charts are replayed from their live ECharts instance (`getInstanceByDom` → `getOption`) into an SSR instance at the printed width and embedded as vector SVG (`charts.ts`). A run takes ~300ms once the compiler is loaded. Points worth not re-deriving:

- **The DOM, not the Markdoc tree.** Every value in the DOM is already queried and formatted by Evidence, and the tree can't be paired with its output: `data-component-id` is the tag's source `line-column`, which two inline tags on one line share. The DOM also carries the reader's choices (selected tab, current table page), matching **Print report**.
- **Every piece of report text is a Typst string literal (`lit()`), never markup**, and structure is emitted in code mode. Report data is arbitrary; one stray `#`, `]` or `$` in a cell would change the document. `tests/unit/evidence-typst.test.ts` round-trips hostile strings through Typst's own `query` and checks that an embedded `#set page(width: 1pt)` changes nothing. `color()` is the one other path into the source, and it only emits hex.
- **Colors go through `resolveColor()` (`css-color.ts`).** Typst's SVG renderer paints CSS Color 4 syntax **black without an error**: chroma.js writes `rgb(255 255 255 / 0.8)` for the reference-line label background, and Tailwind v4 computes to `oklch()`. One canvas pixel converts any syntax to hex. `isChromatic` decides which text keeps its color (deltas, accents); it needs chroma as well as hue ratio, or the warm near-black foreground `#211a12` colors every run.
- **Only a component's own chart or table is its own.** `tabs`, `details` and so on contain other components' ECharts instances. Treating "contains a chart" as "is a chart" exported a tab strip as its first chart, with no title and the second chart lost.
- **`page_break` and `print_group` have `componentWrapper: false`**: no `data-render`, just `break-after-page` / `break-inside-avoid` divs. The extractor follows print CSS in general: `break-before/after: page`, `break-inside: avoid`, and Tailwind's `print:hidden` / `hidden print:block`, read from the class list because the screen's computed style can't see them.
- **Sizes are print sizes.** Charts render at `contentWidthPx()` (1px = 0.75pt, so ECharts' 12px labels print at 9pt); a `row` divides that width. Series-level `animation` must be switched off as well as the top-level flag, or the SSR frame catches a line series' clip-path intro at zero width and draws no line.
- **Typst's first layout pass reads a `state`'s initial value**, before any update has been located, so the template's theme state is seeded with a real theme; a field access on `none` there is a fatal error, not a retry.
- **The page is the report's own content** (`report()` in `template.ts`). No title block and no running header: the report's first heading opens the page, and the title only names the PDF (its document metadata). Every page's footer carries the full refresh date and time, "Generated by Cupola by Query.Farm" (linked) and the page count. After the content, below a rule: the update time, any extra details (a PDF per value's "Sections"), the Filters section and the link back to the view. **Keep the template ASCII** and write other characters as Typst escapes (`\u{b7}`): Bun's transpiler turned a literal "·" in the `String.raw` template into a `\u00B7` escape, which Typst printed as the text "u00B7". A unit test holds the template to ASCII, and another reads the compiled PDF's text with pdf.js.
- **Fonts are Cupola's own, never typst.ts's CDN** (`loadFonts(..., { assets: false })`). `public/typst/fonts/` holds static TTF cuts of Noto Sans, Petrona and JetBrains Mono (Typst reads neither WOFF2 nor variable axes), with their OFL texts. Petrona and JetBrains Mono came through the Google Fonts CSS API with a non-browser user agent, which serves `.ttf`. Noto Sans is built by `scripts/make-pdf-fonts.py` (`uv run --with fonttools --with brotli python scripts/make-pdf-fonts.py`): the variable sources from google/fonts, instanced at 400/600/700 plus italics and subset to Latin, Vietnamese, Greek, Cyrillic and common symbols (about 280 KB a cut, against 2 MB for the full font), keeping every OpenType feature. **Noto Sans replaced Commissioner (0.4.180) because Commissioner has no tabular figures**, upstream included, so table columns never lined up at the decimal point, and `number-width: "tabular"` only switches on a font's own `tnum`. It had no italic either (the template used to skew `emph` word by word). Noto Sans is tabular by default with bold figures as wide as regular ones, so bold total rows align too; several otherwise-tabular fonts (Source Sans 3, Geist) put totals about a pixel off. `evidence-typst.test.ts` measures the digits and resolves every cut with `fallback: false`, because a family name Typst can't find is otherwise a silent substitution.
- **The compiler is 28MB of wasm (~7MB brotli)**, imported with `?url` and fetched on the first export only (`load-compiler.ts`); the Worker, `publish.sh` and the Caddyfile all already serve `.wasm` / `.ttf` with the right types. Compiles are serialized because the compiler holds one shadow file system.
- **Every registered component is classified** in `components.ts` (`native`, `chart`, `container`, `part`, `snapshot`, `input`, `omitted`), and every export returns a `coverage` record of what happened to each component it met. Custom-HTML components with no Typst equivalent (`progress_bars`, `heat_grid`, maps, images, `clock`) are captured with `html-to-image` (`snapshot.ts`). The PDF's own fonts go in as `fontEmbedCSS`, because a `foreignObject` capture cannot see the page's fonts. Maps work because Evidence creates them with `preserveDrawingBuffer`. `html-to-image` is a direct dependency, pinned to the core's version, rather than a transitive hoist.
- **Expand/collapse buttons are content.** Accordion triggers (`data-accordion-trigger`) and the `details` button print as section titles. Collapsed content is not in the DOM at all (`{#if isOpen}`), so the title is marked "collapsed on screen, contents not included" instead of silently vanishing. Plain `aria-expanded` is not the test: popover and menu triggers carry it too.
- **Errors print as errors, checked before anything is skipped.** Evidence has three error markups: the block panel (bad SQL, invalid attribute), the inline "Error" badge on comparisons, and `role="alert"` text (`commentary`). All match `.text-destructive, [role="alert"]`. Only an error the component shows itself counts, not a nested one. The check runs before the input skip: a control that failed (an `option` with an invalid attribute) used to vanish silently with the control.
- **Chart pixel geometry is fitted, not replayed** (`chart-geometry.ts`). Evidence resolves some layout to pixels from the container it measured: a styled funnel stores `left: 115.8, width: 970.2` for a 1086px chart. Replayed at 672px, the bars ran off the page, and Clothing (877k) printed as long as Electronics (1.3M). Pixel margins stay, because they hold labels that don't shrink in print; the lost size comes out of pixel `width`/`height`. The print font also goes into the option before rendering (`withFont`), not only into the SVG afterwards.
- **Table columns are sized from their content, like a browser's automatic table layout** (`table-layout` in `template.ts`). The screen's proportions alone squeezed narrow figure columns until numbers ran into each other (`82,882.2126,779,848,253.79`): a figure has nowhere to break, so Typst lets it overflow into the next cell. Now every column gets at least its widest unbreakable word or number plus padding. If everything fits unwrapped, the spare width is shared in the screen's proportions; if not, it goes to the columns that can wrap. Only then does the text shrink, to 6pt, then the padding halves, and a table still too wide prints a note saying some columns may overlap. The emitter sends each column's few longest strings (`sizingExpr`), and Typst `measure`s only those in the real font. Each table records its widths as `<cupola-table-layout>` metadata, which `evidence-typst.test.ts` reads back. A table of 14 rows or fewer never breaks across pages, so a total row can't be stranded. A cell's fill comes from the cell itself only: a `viz="bar"` cell's inner track is not a fill, and treating it as one shaded every bar row solid tan. On a filled cell the screen's text color is kept, because it switches to white on dark fills. Bold comes from computed weight too (total rows are bold by CSS, not `<strong>`).
- **Big values take the rendered title**: Evidence titles an untitled one itself ("Sum Total Sales"), and only an explicit title reaches `data-component-title`. The value keeps its on-screen size relative to body text (`text_size`).
- **Tabs name the tab that printed** ("Tab: Overview (other tabs not shown: Details, Settings)"); only the selected tab is in the DOM.
- **Snapshots of HTML are laid out at the printed width before capture.** A screen-wide capture shrunk to the page printed `progress_bars` values at about 5pt. Canvas content (maps) is captured as it is, since resizing would force a re-render.
- **Tooltip triggers are skipped only when they hold no text.** The `info` icon is a hover-card trigger, but Evidence's truncating title (`Ellipsis`, used by `details`) is one too, and skipping all triggers dropped collapsed sections' titles.
- **A `row` shares its width among printable children only.** Inputs are removed first; otherwise their slot stays empty and the chart beside them prints stretched to double size.
- **Paged tables print every row, not the page on screen** (`collectPagedTables`). The PDF is a document, so screen paging controls don't limit it. Before the walk, each paged table is stepped through with its own pager, so every value keeps Evidence's formatting, fills and bars. Then the pager goes back to the reader's page. Three things bite:
  - A query-paged table (over 2,000 rows) disables its buttons and shows a skeleton of blank rows while each page loads. Position comes from the "3 of 45" indicator, and rows only count once they are new, non-blank and stable for two frames; otherwise blank rows get printed.
  - Evidence repeats the total row at the foot of every page; it prints once.
  - Query paging costs a query per page, so a table prints at most `MAX_TABLE_ROWS` (2,000, Evidence's own in-browser threshold), and one export spends at most `PAGING_BUDGET_MS` (30s) paging. A table cut short says "Showing the first N of M rows."

  Typst repeats `table.header` on every page a table spans. `tests/evidence-pdf-tables.spec.ts` reads each PDF page's text with pdf.js (`pdfjs-dist`, dev only) to check every row, the header on each page, the single total row, the cap note, and the restored pager.
- **Not yet covered:** inputs are skipped and named in the "Not included" notice; collapsed sections print only their titles; dark-mode reports print on light paper, but their charts keep the screen theme; Perspective pivots below the document are not exported.

`window.__cupolaPdfDebug = true` keeps the last export's Typst source, files and coverage on that global. `tests/evidence-pdf.spec.ts` uses it to check the extraction against a real rendered report.

**The component catalog tests every Evidence component from Evidence's own documentation.** `scripts/evidence-catalog.ts` reads every registered component's schema `examples` from the vendored core into `tests/fixtures/evidence-catalog.json` (98 components, ~300 examples). Playwright can't import the core's schemas itself: it does not transpile TypeScript inside `node_modules`. `tests/fixtures/evidence-catalog-reports.ts` turns the fixture into eight reports by component family, reading the `demo.daily_orders` / `demo.order_details` tables from the Evidence test service's `demo` schema (below). The data runs 2021–2026 at the scale the examples' hardcoded reference lines and targets assume. Don't seed a database named `demo` beside it: with both present, `demo.daily_orders` is an ambiguous catalog-or-schema reference. Each example's query names and input ids are prefixed so examples can share a report. Examples needing semantic metrics, partials or undefined data are marked `skip` with the reason. `tests/unit/evidence-typst-catalog.test.ts` fails when the fixture is stale (`bun scripts/evidence-catalog.ts` regenerates it), when a registered component is missing from `components.ts`, or when a printable component has no runnable example. `tests/evidence-pdf-catalog.spec.ts` renders and exports each report, then asserts invariants rather than pixels: every component on screen appears in `coverage`, none is unclassified, every chart on screen became an SVG, and on-screen errors print as errors. Each PDF is attached to the test result.

**`maplibre-gl` is pinned to 6.4.1 by an `overrides` entry in `package.json`, and must match the core.** Evidence loads MapLibre's worker from a CDN pinned to one version (`MAPLIBRE_GL_VERSION` in the core's `common/maplibre-cdn.ts`), but declares `maplibre-gl: ^6.4.1`, so an install resolved 6.11.1 for the main thread. The protocol drifted and every basemap rendered as a flat gray panel. The point layers and legend still drew on top, and the only trace was `t.codePointAt is not a function` in the console. After upgrading `@evidence/core`, set the override to its `MAPLIBRE_GL_VERSION`. No basemap setup is needed: without a `PUBLIC_MAPBOX_TOKEN`, Evidence uses MapLibre with the free OpenFreeMap tiles. `tests/evidence-pdf-map.spec.ts` measures color variety on each map canvas (a basemap has dozens to hundreds of distinct colors; a flat panel has 1), both on screen and in the PDF's captured images, with a tile-blocked negative control.

The catalog also found an existing Cupola gap that is not a PDF problem. **Evidence's sandbox runtimes are not served** (`/sandbox/html-runtime.js`, `/sandbox/custom-map-runtime.js`, and the one JS-mode `custom_echart` uses all 404, with "Run its `build:sandbox` step"), so `html`, `custom_map` and JS-mode `custom_echart` fail on screen too. Six documented examples fail in Evidence itself on DuckDB and are skipped by name in `scripts/evidence-catalog.ts` (`BROKEN_UPSTREAM`). The demo data carries the extra columns other examples read (`quantity`, `item`, `image_url`), plus a `toStartOfMonth` macro for examples written in ClickHouse SQL.

**Evidence report parameters: choices from queries, cascades, URL state and drilldown** (`src/lib/evidence/parameters.ts`, `parameter-graph.ts`, `parameter-choices.ts`, `parameter-url.ts`, `parameter-lint.ts`, `drill.ts`, `filter-summary.ts`). Report parameters are Cupola's, distinct from Evidence's in-page inputs (`{% dropdown %}`): they sit in the parameter bar, bind into any SQL as prepared values, live in the URL, print in the PDF and can cascade. The two systems are bridged, not merged. Points worth not re-deriving:

- **Types** are text, number, date, boolean, `select`, `multi_select` and `date_range`, with the older report system's binder (`compileReportQuery`): a multi-select expands to `?, ?, …` for `IN ($key)`, a date range is `$key_start` / `$key_end`. **`$key_all` is TRUE when a choice is All or unset**, the idiom being `($key_all OR col IN ($key))`. `$key IS NULL` can't be the idiom: a multi-select has no single value to test.
- **Dependencies are inferred, never declared**: a `$country` in `state`'s choices query makes `state` depend on `country`. `parameterGraphErrors` rejects unknown references, self-references and cycles at validation. `resolveChoices` walks parents first, runs each choices query with its parents' *fitted* values, and fits each value to its new choices (`reconcileValue`): a value that stops being a choice resets per `defaultMode` with a reader-visible note, named by the label from the *previous* choices (the new ones no longer have it). **Refresh runs the same resolver before binding**, so a Refresh pressed mid-cascade never binds a stale child. Choices are cached by SQL plus bound values, so a parent change re-runs only its children.
- **Explicit reader values win on screen; fitted values fill the rest.** Only explicit values that stop being choices are written back into the report, so opening a report with `defaultMode: "first"` doesn't make it dirty.
- **URL state is `p.<key>`**, prefixed so it can't collide with Evidence's own input params (`?category=`) or Cupola's. Only values that differ from the initial value are written. A reader's Refresh pushes a history entry, Back/Forward re-applies (`completeValuesFromUrl`), and opening a shared link makes its values the saved baseline, so following a link doesn't count as an unsaved change.
- **The bridge**: each parameter except date ranges is registered as an Evidence `ExternalFilter` before the document is processed, so `filters=["key"]` and `{{key}}` work on it (comparing `filterColumn`, default the key). `setDefault` is used rather than assignment: it never writes the URL, and the document is rebuilt every refresh anyway. A parameter named like an input id is a lint error.
- **Drilldown needs no Evidence markup.** A drill path is report data (`drillPaths: [{ levels: ["country", "state", "city"] }]`), because Evidence's tag schemas reject unknown attributes. A click drills when the clicked ECharts category, or a table cell's text, matches a choice of the next unset level, by label and then by value. Matching cells are made `role="button"` and focusable, so drilling works from the keyboard. A drill applies at once and pushes history (Back steps up a level), and the breadcrumb clears lower levels. **Evidence's own row `link` calls `window.open(url, "_self")`, which navigates the whole Cupola tab away**; it was never usable for drilling.
- **The PDF's Filters section** (`summarizeFilters`) lists the drill path, every parameter by its labels and every Evidence input on the page (read from the page-filters context, titled from the processed Markdoc tree, since the DOM doesn't link an input's id to its title). Inputs that set filters are classified `filter`, not `input`: the control doesn't print, but it no longer counts as "not included". Lists past 8 values go to a "Filter values" appendix. A saved report's PDF links back to its view, with the fragment stripped. **PDF per value** (⋯ menu) re-renders the report once per choice (at most 25) into one PDF via `createPdfExport` / `addSection`, with a file prefix per section because each extraction numbers its assets from 1, then restores the reader's view. `settledRoot` waits for a new document root, no report queries and no chart still drawing.
- **Refresh vs Stop**: an explicit refresh swaps the button to Stop at once, but lazy renderer queries (a chart scrolling into view) offer Stop only after 400ms. They used to flip it instantly, and React reused the same DOM node, so a click aimed at Refresh landed on Stop. `refresh()` with no argument reads `reportRef`, which `change()` updates synchronously: CodeMirror reports edits outside React events, so ⌘Enter pressed right after typing refreshed the previous draft.
- **Tests**: `tests/evidence-parameters.spec.ts` and `tests/evidence-drill.spec.ts` run on the Evidence test service's `geo` schema (country → state → city, `tests/fixtures/evidence-geo-report.ts`); the saved-reports list offers a "Use drilldown example" template on that service. Replace long CodeMirror text with `replaceEditorText` (helpers.ts), not `fill()`: CodeMirror renders only the lines near the viewport, so `fill()` replaced those and kept the rest.

**The editor's Performance tab profiles each refresh** (`refresh-profile.ts`, `EvidencePerformance.tsx`). `RefreshProfiler` records phases (engine wait, parameter choices, setup SQL, semantic datasets, rendering) and every query on one `performance.now()` clock, from four sources: `HaybarnQueryService` (component queries, plus cache hits logged as cached), the choices loader's `observe`, the setup SQL, and `prepareEvidenceSemanticDatasets`'s steps (compile and materialize are separate entries). Component queries are named after the report query whose SQL they contain (`nameRenderQueries`); Evidence never runs a named query on its own, so they read `by_city · component`. Two timing subtleties:
- **Rendering ends when the document has mounted *and* its queries have been quiet for 700ms.** Quiet alone ended the profile before the document had even loaded its code, which put every render query "after the refresh".
- **A choices load is "cached" only if it had already finished.** A refresh joining one the parameter bar started is a real wait; calling it cached hid a 4.6s query.
Open in Query Editor fills `$parameters` in with the refresh's values (`materializeReportQuery`), so what it opens runs as is.

**Lossless Arrow conversion** (`duckdb-worker-boot.ts`): the worker opens the database with `db.open({ arrowLosslessConversion: true })`. Without it DuckDB collapses its own types to lossy primitives — `UHUGEINT` becomes a *signed* `DECIMAL(38,0)` so `2^128-1` reads as `-1`, `BIT` becomes an untagged `BLOB`, `TIME_TZ` becomes a plain `TIME` with its offset thrown away — and none carry `ARROW:extension:metadata`, so the handlers in `format.ts` that key off it silently never fire. That shipped for a long time: the shell rendered BIT columns as hex blobs and UHUGEINT as `-1`.

**This must be the config key, not `SET arrow_lossless_conversion = true`.** haybarn's exporter reads `webdb_.config_->arrow_lossless_conversion`, a C++ field fixed at instantiation (`lib/src/webdb.cc`, whose comment says the flag is "pinned by the wasm packaging layer … rather than driven from session settings"). `WebDB::Open` pushes that field *into* DuckDB's setting one-way at startup, so a later `SET` updates a setting the exporter never reads — `current_setting()` cheerfully reports `true` while the output stays lossy. `arrow_output_version` is pinned the same way (`ArrowFormatVersion::V1_0`), so setting it does nothing either. `.test_formats` is the guard.

**Terminal readiness is not `terminal.runQuery` being set** (`shell-init.ts`): `runQuery` drives the terminal through `term.paste()`, which xterm-readline only accepts from inside `rl.read()`. Outside it the input is dropped, or throws `Cannot read properties of undefined (reading 'inputType')`. The post-ready handoff therefore resolves the prompt's catalog **before** hiding the boot overlay and publishing `runQuery`, so `readLoop()` runs synchronously as far as its first `rl.read()`. **Do not add an `await` ahead of that read.** It previously did (`await refreshCatalog()` was readLoop's first line), which left a window one query round-trip wide where the shell looked ready but silently swallowed anything submitted — a fast user, or the editor / query-history / AI panel reacting to `duckdb-ready`. Safari hit it constantly because its slower WASM widens the window; the only recovery was reloading. `waitForShell` in `shell.spec.ts` guards it by requiring the terminal to echo a `.help`.

**Arrow-to-DuckDB types**: Column types from the VGI server are Arrow types (Utf8, Int64, Date32). `arrow-to-duckdb.ts` converts these to DuckDB display names (VARCHAR, BIGINT, DATE). Checks `ARROW:extension:name` metadata for `geoarrow.wkb` → `GEOMETRY`.

**SQL string literals vs identifiers**: use `quoteLiteral()` for VALUES and `quoteIdent()` for NAMES, both from `src/lib/duckdb-query.ts`. Mixing them is silent: `WHERE database_name = "memory"` is an identifier reference, so DuckDB raises `Binder Error: Referenced column "memory" not found`, and callers that treat a failed query as "not found" swallow it. That bug disabled `describe_table` for memory/attached catalogs for many releases.

**Hash routing**: Navigation state is encoded in the URL hash (`#/schema/property/table/parcels`) so users can share deep links. Uses `pushState` + `popstate` for browser back/forward.

**Shell bridges** (`src/lib/shell-bridge.ts`): three typed globals for cross-component messaging, grouped by who owns them. `engine` (owner: `duckdb-worker-boot`) — `query`, cancellation, boot phase/progress, and the `attached` ATTACH barrier. `terminal` (owner: `shell-init`) — the xterm instance, `runQuery`, `insertText`. `ui` (owner: React) — `openInEditor`, `navigateToSelection`, `showPerspective`/`showPreview`, `addQueryHistoryEntry`, memory-catalog refresh. This replaced a single ~35-slot `bridge` object that mixed all three, so every consumer imported the whole surface and nothing typed which module was allowed to write which slot. Components subscribe to `engine.query` availability via `onQueryChange`/`notifyQueryChange` so features like column stats can retry after the shell finishes initializing. Nullable slots and their `?.()` guards are deliberate — these are genuinely late-bound. **`window.__bridge` is a separate, deliberately FLAT facade for Playwright** (nine specs address it by the old names); it delegates via getters, so extend it rather than reshaping it.

**Eager worker boot** (`src/lib/duckdb-worker-boot.ts`): The DuckDB WASM worker is created at CatalogApp mount time (not when the shell panel opens), so the worker is typically ready by the time the user clicks "Open SQL Shell". Pre-allocates SharedArrayBuffers for query cancellation and OAuth.

**Column stats and profiling**: `fetchColumnStats()` (in `service.ts`) queries DuckDB's `vgi_table_statistics()` for per-column min/max/nulls/distinct counts; it internally awaits `bridge.attached`, so callers like `TableDetail` can fire it immediately even before the shell finishes attaching. `ColumnProfile` provides deeper on-demand distribution analysis.

**Grid column sizing** (`DataGrid.tsx`): widths are measured once per result set and then frozen into a `<colgroup>` (virtualization needs a stable layout). The measuring pass runs at `width: max-content` — at the default `w-full` the browser hands the spare panel width to the columns, which is how a single-column result used to freeze at the full panel width. Measured widths are clamped to `[48px, min(400px, 60% of the panel)]`, DBeaver-style, and the leftover goes to a **trailing spacer column** (the only auto-width `<col>`) so stripes and the sticky header still span the panel without inflating the data columns. Each header carries a resize handle: drag to set a width, double-click to autofit (canvas `measureText` over the rendered rows — the frozen layout clips cells, so the DOM can't report a natural width). Hand-set widths are kept in a ref keyed by **column name**, so they survive the re-measure a sort or pager jump triggers, and are cleared only when the column set changes. Sortable headers always reserve the chevron's 16px so sorting can't truncate a content-sized header.

**Tags system**: VGI servers attach reserved `vgi.*` metadata tags to catalog objects, per the vgi-lint-check `TAGS.md` standard (`~/Development/vgi-lint-check/TAGS.md`). The canonical vocabulary and all handling live in `src/lib/tags.ts`:
- **Docs**: `vgi.doc_llm` (AI-facing narrative), `vgi.doc_md` (human Markdown), `vgi.result_columns_md` (table-function result columns).
- **Discovery**: `vgi.title`, `vgi.keywords` (JSON string[]), `vgi.category` (an object's primary category) + `vgi.categories` (a schema's ordered category registry), `vgi.classification_tags` (cross-cutting facets), `vgi.doc_links`.
- **Examples**: `vgi.example_queries` and `vgi.executable_examples` (both rendered via `ExampleQueries`).
- **Catalog provenance**: `vgi.source_url`, `vgi.author`, `vgi.copyright`, `vgi.license`, `vgi.support_contact`, `vgi.support_policy_url` (shown by `ProvenanceCard`).
- **Excluded entirely**: `vgi.agent_test_tasks` — grader-only; never displayed and never sent to the AI agent.

Read reserved tags via `getTag(tags, TAG_*)`, which resolves the canonical key and transparently falls back to the deprecated alias (`vgi.description_llm`/`_md`, `vgi.columns_md`, `vgi.category_tags`). JSON-valued tags are decoded by defensive parsers (malformed → empty, never throw). `filterDisplayTags` strips every reserved key from the raw `TagsTable` (only free-form keys like `domain`/`provider` show); `filterTagsForAI` keeps the LLM discovery signals and drops heavy/grader tags. Categories drive grouped sections on the schema detail page only (`groupByCategory`) — the sidebar tree is intentionally left flat.

**Prompt caching is a prefix match, so the agent's prompt is assembled to be byte-stable** (`ai-agent.ts`). Render order is `tools` → `system` → `messages`; a changed byte anywhere invalidates everything after it. The request carries three breakpoints — top-level `cache_control` (auto-advancing with the conversation tail), one on the **last** tool of whatever set the caller passed (never a hardcoded index, or surfaces shipping different tool subsets fragment the cache), and one per `cacheControl` system block. The reports path uses all four slots; a fifth explicit marker is a 400, not a slowdown.

What makes this fragile is that a break is **silent** — requests keep succeeding, the bill is just higher. Two shipped that way and are worth not reintroducing:

- **Nothing mutable belongs in `system`.** It renders ahead of every message, so a changed byte there drops the system cache *and* the whole accumulated conversation. The reports agent kept `Current report: {json}` in a system block (with a breakpoint on it, writing an entry nothing could read), and `AskAIChat` rebuilt the entire prompt each turn from `ui.memoryCatalog` — which the agent itself changes by doing what the prompt tells it to (`CREATE TABLE memory.main.…`). Both now freeze the prompt and put mutable state in the trailing user turn: the report draft directly, memory drift via `ai/memory-context.ts`. `.ai` terminal mode was always right — it builds the prompt once per session.
- **History must stay append-only.** Rewriting an earlier turn is the same invalidation in a different place — and newer models reject edited history that carries signed thinking blocks, which is now the default on Opus 5 / Sonnet 5. Earlier report snapshots keep their own values rather than being updated, which is why they are labelled "at the start of this turn". Two sanctioned exceptions, both of which no-op in a normal conversation: `sanitizeConversation` (only repairs a broken history) and `pruneCarriedToolImages`, gated by `shouldPruneCarriedImages` to fire only past half the model's context window (`modelContextWindow` in `ai/model-limits.ts`). The prune used to run on **every round**, shedding each chart two rounds after it was drawn — a cache break per chart, to save an image that is only ~530 tokens (feedback PNGs are 800×500; the old comment said ~1.5k) and costs ~53 token-equivalents per request to carry at the read rate. With a 1M window a conversation would need well over a thousand charts before images mattered. When the valve does fire it sheds every carried image at once (pruned results become strings, which it skips), so it is one break, not one per chart. The estimator prices images as images — counting base64 as text would overstate a chart ~50×.

The guard is `tests/unit/ai-agent-cache.test.ts`: asserting a breakpoint is *placed* stays true while the bytes behind it churn, so it asserts the earlier request's rendered prompt reappears **unedited** as a prefix of the later one (`cache_control` stripped — the advancing marker legitimately differs). Cache-miss diagnosis (`cache-diagnosis-2026-04-07`) is wired behind `window.__cupolaAiCacheDiagnostics = true`, which names server-side where two requests diverged; the chat and `.ai` surfaces both display the per-turn hit rate.


## Settings

Stored in localStorage (`vgi-frontend-settings` — key name predates the Cupola rename, do not change it or users lose their settings):

| Setting | Default | Description |
|---------|---------|-------------|
| `showDuckDBTypes` | `true` | Show DuckDB type names instead of Arrow types |
| `hideTableBackingFunctions` | `true` | Hide table-backing functions from sidebar |
| `hideDollarTables` | `true` | Hide tables whose name contains `$` |
| `shellFontSize` | `13` | Terminal font size |
| `shellThreads` | `0` | DuckDB WASM thread count (0 = auto) |
| `previewRowsPerPage` | `50` | Remembered rows-per-page for the data preview grid (editor results + catalog Preview Data). One of DataPreview's `PAGE_SIZES`. |
| `geometryAsText` | `false` | Render geometry columns as WKT text instead of a clickable map preview (`GeometryViewer`) |
| `numberGrouping` | `false` | Group digits in numeric grid cells using the browser's locale (`1,234,567`). Applied via `formatCellValue`'s opt-in `grouping` option and passed only from `DataGrid`/`DataPreview` — CSV/XLSX export, clipboard copy, the AI agent's view (`query-results.ts`) and the terminal deliberately stay ungrouped, since a grouped number lands in Excel as text, pastes across two cells, and is not arithmetic the agent can do. Swaps the decimal separator too: in `de-DE` the group separator is `.`, so grouping alone would make `1234567.89` ambiguous. Type-gated because DuckDB's `BIT` renders as a digit string |
| `anthropicApiKey` | `""` | Claude API key for AI features |
| `anthropicWorkspaceId` | `""` | Optional `wrkspc_…` ID sent as `anthropic-workspace-id`. Required for identity-linked personal/service-account keys with access to multiple Anthropic workspaces; omitted for ordinary workspace-scoped keys. |
| `aiModel` | `"claude-sonnet-5"` | Claude model for the AI agent. The picker offers Haiku 4.5, Sonnet 5 and Opus 5; superseded IDs are auto-migrated on load via `SUPERSEDED_MODEL_REPLACEMENTS` in `settings.tsx`, which covers both models Anthropic retired (staying put is an API error) and ones merely superseded (staying put just costs more). A model ID must appear in **four** places or it degrades silently rather than erroring: the picker, `MODEL_PRICING` (`pricing.ts`), `MAX_OUTPUT_TOKENS` (`ai/model-limits.ts`) and `ADAPTIVE_THINKING_MODELS` (`ai/model-features.ts`). `tests/unit/ai-model-features.test.ts` asserts the first three agree. |
| `aiEffort` | `"high"` | Thinking depth for models with adaptive thinking (`low`/`medium`/`high`/`xhigh`/`max`). `high` is the API's own default, so pinning it is a no-op for the prompt cache. The Settings row is **hidden** for models without it — `output_config.effort` is a 400 on Haiku 4.5. Read once per turn and held across the tool loop: an effort change invalidates the messages cache. |
| `aiMaxToolRounds` | `20` | Max tool-use rounds per AI conversation |
| `aiMaxTokens` | `16384` | Max output tokens per AI request. Clamped to the selected model's own ceiling by `clampMaxTokens` in `src/lib/ai/model-limits.ts` — Haiku caps at 64K, Sonnet/Opus at 128K, and exceeding a model's ceiling is a 400. Was hardcoded at 4096, which truncated long `tool_use` blocks (large Vega specs) mid-JSON. |
| `aiChartFeedback` | `true` | Feed rendered chart PNG back to the agent so it can iterate |
| `aiTelemetry` | `true` | Send AI conversation analytics to Sentry (user opt-out) |

**Thinking is model-gated, and its default differs by model** (`src/lib/ai/model-features.ts`). Omitting `thinking` means *no thinking* on Sonnet 4.6 and Haiku 4.5, but Opus 5 and Sonnet 5 run adaptive thinking when it is omitted — so adding those models silently turned thinking on. The agent therefore sends the field explicitly (or not at all), never relying on a per-model default. Two consequences worth not re-deriving:

- **`thinking` / `redacted_thinking` blocks must round-trip verbatim.** The SSE parser handled only `text` and `tool_use`, so thinking blocks were dropped from the assistant turn that got pushed into history; the API authenticates them by signature and rejects a turn they were removed from, which wedges the conversation from that point on. `dropToolUseFromLastAssistant` (the cancel path) keeps them for the same reason — it strips only the unmatched `tool_use`.
- **`display` is left at its default (`"omitted"` on these models).** The blocks still arrive and still bill identically; they just carry no text. `onThinking` exists on `AgentCallbacks` so opting into `display: "summarized"` is a one-line change rather than a parser change.

## Observability (Sentry)

Both runtimes report to one Sentry project (`query-farm-llc/cupola`) under the shared release slug `cupola@{version}+{gitHash}`.

- **Browser** (`sentry.client.config.ts`): `@sentry/astro`, initialized only in PROD builds. `environment` is `window.location.hostname` so each installation (Cloudflare, self-hosted, localhost preview) is distinguishable. `beforeSend`/`beforeSendTransaction`/`beforeBreadcrumb` scrub the `Authorization` header, `_vgi_auth` cookie, and secret URL params via `src/lib/sentry-scrub.ts`.
- **Worker** (`worker/index.ts`): `@sentry/cloudflare` `withSentry`; version/hash injected at deploy via wrangler `--define`. Same scrubbing.
- **AI agent monitoring**: manual gen_ai instrumentation in `ai-agent.ts` (the agent uses raw fetch, so no Sentry auto-instrumentation). Span tree: `gen_ai.invoke_agent` root per turn (via `startNewTrace`) → `gen_ai.chat` per API request → `gen_ai.execute_tool` per tool call. Attribute mapping lives in `ai-telemetry.ts`; key rule: `gen_ai.usage.input_tokens` must INCLUDE Anthropic's separately-reported cache tokens (`.cached`/`.cache_write` are subsets) or Sentry computes negative costs. Conversations are grouped via `Sentry.setConversationId` (UUID per chat-panel or `.ai` session). Users opt out via the `aiTelemetry` setting.
- **Sampling**: `tracesSampler` keeps AI agent traces at 100%, everything else at 10%. `sendDefaultPii: true` + `streamGenAiSpans: true` power the Conversations view.
- **Source maps**: vite emits `'hidden'` maps (must be set under `vite.environments.client.build` — Astro 6 ignores the top-level setting). With `SENTRY_AUTH_TOKEN` set, `@sentry/astro` uploads them during build and deletes them from `dist/` afterwards. **Gotcha**: the `sentry()` integration options must be top-level — the deprecated `sourceMapsUploadOptions` wrapper silently ignores nested `release`/`sourcemaps` objects (this shipped maps to R2 for ~45 releases before being caught). `publish.sh` fails the publish if maps survive the build or the upload-success log line is missing, and strips client maps before the R2 sync regardless. Worker maps are uploaded by `publish.sh` via `sentry-cli` under the same release.

## Color Theme

Default VGI green palette defined in `src/styles/global.css`:
- Background: `#faf8f0` (warm cream)
- Primary: `#2d5016` (forest green)
- Accent: `#4a7c23` (leaf green)
- Muted: `#6b6b5a`
- Border: `#f0ece0`
- Card: `#ffffff`

Custom themes can be loaded via `?theme=<url>` parameter. Theme JSON includes colors and optional terminal theme. Cached in localStorage.

## OAuth / Authentication

When a VGI server has OAuth PKCE enabled:
1. The frontend reads the JWT token from the URL fragment (`#token=...`) or `_vgi_auth` cookie
2. Token is sent as `Authorization: Bearer` header on all RPC calls
3. `getUserInfo()` in `src/lib/auth.ts` decodes the JWT payload; identity is shown in the header / `ServiceSwitcher`
4. Token from fragment is cached in memory and cleaned from the URL
5. The DuckDB extension handles its own PKCE flow for ATTACH — uses SharedArrayBuffer to route auth codes from a popup back to the worker thread
6. Per-catalog identity is fetched via `catalog-identity.ts` and displayed in `ServiceSwitcher`

## Testing

Unit tests are pure-logic bun tests in `tests/unit/` (`bun run test`); the AI agent's helper modules (`ai-fetch`, `ai-history`, `ai-telemetry`, `sentry-scrub`, etc.) are deliberately free of service/VGI imports so they stay unit-testable.

For end-to-end work, test with Playwright (or Playwright MCP) against a running VGI server. The repo carries its own — `test-worker/` serves the synthetic `cupola_test` catalog on the suite's default port, with small report-friendly tables, 100k–2M-row stress tables (`large.orders_400k` is the size that killed the tab), type/shape edge cases, and slow/failing/rate-limited table functions:
```bash
# Start the test VGI worker (no auth) — needs only uv
./test-worker/run.sh                                           # :9009

# Start frontend dev server
cd ~/Development/vgi-web-frontend && bun run dev

# Test in browser
http://localhost:4321/?service=http://localhost:9009
```

**The VGI DuckDB extension is installed unpinned, and the test worker tracks the current releases with it.** `SHELL_EXTENSIONS` (`duckdb-engine.ts`) emits a bare `INSTALL vgi FROM community`, so a browser gets whatever the community repository currently serves for its DuckDB version; `stress_worker.py` pins the vgi-python / vgi-rpc releases that speak what that build speaks, and the two move together. Cupola pinned an exact build for a while, and the cost compounded: every extension fix needed a Cupola release, and the pinned build's wire protocol froze the servers it could talk to. `?vgi_version=<build>` still pins per tab for reproducing one specific build, and `./test-worker/run.sh --latest` resolves the newest worker regardless of the script's pins.

Two vgi-rpc changes set the floor, and **each fails somewhere other than where it looks**: 0.45.0 began advertising `VGI-Accept-Max-Response-Bytes-Support`, which the current extension demands at ATTACH — an older worker still serves the sidebar tree over HTTP and only the SQL shell is dead, with `IO Error: VGI HTTP server does not advertise …` buried in the console. 0.46.0 retired the `__describe__` method for the co-hosted `vgi_rpc.Reflection.v1` protocol, which is how the TypeScript client discovers a server — an older worker 404s the catalog fetch instead and nothing renders at all.

The suite must not depend on one developer's dataset. Specs discover the attached
catalog (`information_schema.schemata` minus `memory`/`system`/`temp`) and
`test.skip` when there is none, rather than naming one — `shell.spec.ts` used to
hardcode `albemarle_gis` and failed everywhere else. Three env vars keep a run
portable:

| var | purpose |
|-----|---------|
| `VGI_SERVICE_URL` | VGI server (default `http://localhost:9009`) |
| `CUPOLA_APP_ORIGIN` | app origin — **set this when 4321 is taken**; `astro dev` silently falls through to 4322/4323 and the suite would otherwise drive whatever else is squatting there |
| `CUPOLA_BASE` | base path, e.g. `/v0.4.109/` |

**Evidence specs run against Cupola's own test service**, `https://vgi-cupola-test.rusty-bb6.workers.dev` (repo `~/Development/vgi-cupola-test`, TypeScript on Cloudflare Workers). Its `main` schema has the Open-Meteo functions the weather example calls, replaying recorded responses with dates shifted to today, so no spec calls the real weather API. Its `demo` schema serves the Evidence demo tables. `evidencePath()` in `tests/helpers.ts` adds `service=` to every `evidence…` navigation (`CUPOLA_EVIDENCE_SERVICE` overrides), and `isWeatherService()` (`src/lib/evidence/weather.ts`) offers the weather example on both that service and the real Open-Meteo Worker. A new weather query the recordings don't cover fails with `No recorded response for …`: record it in that repo (`make record`) and redeploy.

**Evidence's libraries are pre-bundled for dev** (`optimizeDeps.include` in `astro.config.mjs`). `@evidence/core` is excluded from pre-bundling (raw `.svelte`/`.ts` using `import.meta.glob`), so Vite never discovered what it imports: `lucide-svelte` alone was served as about 3,500 separate icon modules on every page load (6,178 requests in all). Pre-bundling `lucide-svelte`, `date-fns` and `chroma-js` cuts that to about 2,300. `bits-ui`, `runed` and the rest of the toolbelt family stay unbundled on purpose: the `evidence-svelte-exports` resolver keeps per-importer copies of them. **The suite runs on bundled Chromium, not branded Chrome** (`channel` in `playwright.config.ts`; `PW_CHANNEL=chrome` opts back in). Google Chrome starts its updater (`UpdaterMain --wake`, `--crash-handler`) once it has been up a while, and Playwright waits for those processes before a browser counts as closed: about 25s per browser, and at the end of a run the workers holding them were force-killed after 5 minutes ("worker process did not exit within 300000ms after stop"). The 11 Evidence and report-builder specs took 16.3 minutes on Chrome and 2.9 on Chromium.

**The suite bounds its own parallelism** (`workers` in `playwright.config.ts`, default 4, `PLAYWRIGHT_WORKERS` overrides). Playwright's own default is half the machine's cores, which made the result depend on the machine: on a 20-core host that is 10 parallel browsers, and full-suite runs there failed anywhere from 4 to 26 tests — almost all of them "the DuckDB bridge never became ready", on whichever test happened to run beside a heavy one. Each test boots its own 44MB DuckDB-WASM engine and then queries one single-process VGI worker. Two plausible culprits were measured and ruled out, so don't re-derive them: the **dev server** serves that wasm in 40ms idle and 250ms with ten in flight, with small requests unaffected throughout (its `readFileSync` of a 44MB blob is ugly but not the bottleneck), and **per-browser DuckDB threads** don't matter either — 12 parallel boots averaged 5-6s both at `hardwareConcurrency` and at a fixed 4. Raising the *worker's* thread pool made it worse, not better: it is one GIL-bound process. Budgets are sized for a loaded machine rather than an idle one — 60s per test (two cold engine boots fit in a reload test), and `.test_formats` waits 150s for its ~110 sequential comparisons.

**After bumping the version, restart `bun run dev`.** `astro dev` computes `base` from `package.json` at startup, while `helpers.ts` reads it per run — so a server started before the bump serves `/v<old>/` and every spec 404s into a blank page, failing in `gotoApp` with a misleading "tree never became visible".

`.test_formats` compares the terminal formatter against DuckDB CLI reference
output and tolerates `≥106`/`≤4`. The 4 permitted failures are rendering-only:
`timestamp_tz[0/1]` and `timestamptz_array[1]` (DuckDB WASM ICU prints a DST
offset where the reference used a fixed one — the instants agree), and
`varchar[1]` (embedded tab collapsed by the terminal). It was 9 until
`arrowLosslessConversion` was enabled; do not widen the tolerance to absorb a
regression.

## Publishing & Deployment

Assets are served from Cloudflare R2 via a Worker (`worker/index.ts`, configured in `wrangler.jsonc`). The URL scheme is versioned:
- `/` → 302 → `/latest/`
- `/latest/` → 302 → `/v{current}/` (reads `_latest` marker from R2)
- `/v{version}/*` → immutable versioned assets from R2

**To publish a new version:**
1. Bump `version` in `package.json`
2. Run `./publish.sh` (or `./publish.sh --skip-commit` if already committed)

`publish.sh` handles: git commit/push/tag, build, Sentry source-map upload checks, upload all assets to R2 under `v{version}/`, update the `_latest` marker, and deploy the Worker.

**Key details:**
- `astro.config.mjs` sets `base: /v{version}/` so all emitted asset paths are versioned (`BASE_PATH=/` overrides for the flat Docker/Azure deployment)
- Haybarn DuckDB-WASM artifacts and the VGI extension wasm are staged into `dist/haybarn/` and ride along with the versioned sync
- The Worker serves from R2 with edge caching (`caches.default`)
- `wrangler.jsonc` binds the `cupola-assets` R2 bucket as `ASSETS_BUCKET`
- `/oauth-callback.html` is served at a stable unversioned URL (Entra SPA redirect URI)

**Error page** (`worker/error-page.ts`): the worker's three failure paths return a branded, self-contained HTML page instead of bare text — `outdated-version` (404, the `/v{semver}/` prefix has no `index.html`), `not-found` (404), and `not-deployed` (503, no `_latest` marker). The variant is chosen in `worker/index.ts` by probing `v{version}/` after the asset lookup fails, so "your release is gone" is never confused with "that path doesn't exist inside a live release".

Points worth not re-deriving:
- **HTML only for documents.** `wantsHtml()` gates on `Accept: text/html`; a missing `.js`/`.wasm` keeps its plain-text 404, because handing a `<script>` tag a page of HTML is worse than the bare status.
- **The redirect is client-side on purpose.** The URL fragment (`#token=`, `#sql=`, `#/schema/...`) never reaches the worker, so only `location.replace("/latest/" + location.search + location.hash)` can carry a user's auth token, shared SQL, and selection route across. `replace`, not `href`, so Back skips the dead URL.
- **Redirect loop guard.** If `_latest` ever names a version whose `index.html` is missing, `/latest/` → `/v{x}/` → 404 → redirect would spin. A `cupola-error-redirected` sessionStorage sentinel lets the auto-redirect fire once, then falls back to a manual button. The 8s countdown also cancels on any keypress/scroll/pointer event so it can't yank a page away mid-read. `not-deployed` never auto-redirects — `/latest/` is the broken thing.
- **Styling is bundled, not fetched.** Tailwind is build-time, so the page can't reach the app's CSS; it inlines the `global.css` token hexes with a `prefers-color-scheme` dark block, and replays `Layout.astro`'s pre-paint script (`vgi-theme-cache`) so `?theme=` installs don't flash stock green. Deliberately **not** copied from `public/oauth-callback.html`, whose palette has drifted stale.
- **The logo is `/cupola-icon.png`** — the illustrated barn cupola `BrandMark` renders, referenced unversioned (the latest-version fallback resolves it) rather than inlined, since base64 would add ~126KB per response. `public/cupola-icon.svg` is a different lineart mark the app never shows. An `onerror` hook hides the image in the one case the fallback can't resolve: the empty-bucket 503.
- All error responses are `Cache-Control: no-store` — a version that 404s today may be restored.

**CI publishing** (`.github/workflows/release.yml`): tag-driven workflow that installs published npm dependencies, runs validation, publishes the multi-architecture container image, deploys Cloudflare, and creates the GitHub release.

The Cloudflare job reads these secrets from the GitHub `production` environment:

- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: R2 credentials with write access to `cupola-assets`, passed to the AWS CLI as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
- `CLOUDFLARE_API_TOKEN`: a Worker deployment API token for the account configured in the workflow.
- `SENTRY_AUTH_TOKEN`: enables source-map uploads; optional for deployment.

`scripts/publish-credentials.sh` validates the required credentials before the deployment job installs dependencies and before `publish.sh` commits or builds. CI requires explicit credentials; a developer's local AWS profile and interactive Wrangler login are unavailable on the runner. Local publishing still defaults to the `cupola` AWS profile and supports Wrangler login. Explicit AWS credentials clear any selected profile so a stale profile cannot break CI.

## VGI Dependencies

Both VGI clients use exact published npm releases, making local and CI builds
self-contained:
- `vgi` → npm alias for `@query-farm/vgi`
- `@query-farm/vgi-rpc` → published `@query-farm/vgi-rpc`

These are **not** independent of the extension pin: now that `INSTALL vgi FROM
community` is unpinned, a browser's DuckDB talks to servers new enough for the
current extension build, and these clients have to reach the same servers. They
move with `stress_worker.py`'s pins and the extension together — see the
schema-path and capability-probe notes above for what changed in the jump from
`vgi@0.28` / `vgi-rpc@0.21`.

A third sibling is needed only to **rebuild** Perspective, not to build or run cupola:
- `~/Development/perspective` → the Query-farm fork, branch `duckdb-type-support-v5.5`. Consumed as prebuilt artifacts committed under `public/perspective/`, so a normal `bun run build` does not need it. See "Vendored Perspective" above and `./build-perspective.sh`.
