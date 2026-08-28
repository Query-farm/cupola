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
.github/workflows/
  publish.yml                # Manual-dispatch CI publish (inactive until secrets are set)
```

## Key Design Decisions

**Browser-only imports**: The main `@query-farm/vgi-rpc` and `vgi` packages include Node.js code. The frontend uses:
- `vgi/client` — browser-safe entry point (no node:fs, node:os)
- `@query-farm/vgi-rpc/connect` — aliased in `astro.config.mjs` to the source client module

**Node stubs** (`src/lib/node-stubs.ts`): Apache Arrow's Node.js I/O modules reference `node:stream` etc. These stubs provide minimal class shells so `class X extends Readable` doesn't throw. They are aliased in `astro.config.mjs`.

**One Apache Arrow, everywhere**: application code imports Arrow **only** from `@query-farm/apache-arrow` — never bare `apache-arrow`, and never from a CDN. Arrow objects cross the boundary between cupola and the sibling repos (`vgi/client`'s `deserializeSchema` hands back `Field`s), so more than one build on the page means structurally-identical-but-nominally-distinct types and cross-version IPC bugs. Three copies used to ship at once: a phantom `apache-arrow@17` (imported by 10 modules but absent from `package.json`, resolving via a transitive hoist), `@query-farm/apache-arrow@21.1.1` from vgi-typescript's own `node_modules`, and `apache-arrow@18.1.0` fetched from jsdelivr at runtime by `DuckDBShell`. The hoist is `@haybarn/haybarn-wasm`, which declares `apache-arrow: ^17.0.0` (`bun.lock`) — **not** `@perspective-dev/client`, which never declared Arrow at all and is no longer a dependency. Keeping it to one requires **all three** of: the pinned `@query-farm/apache-arrow` dependency, `vite.resolve.dedupe` in `astro.config.mjs`, and the matching `paths` entry in `tsconfig.json` (the latter two must stay in sync, and the sibling sources resolve their own copy without them). Unit tests must import Arrow from the same package or they will build tables the code cannot decode. `@haybarn/haybarn-wasm` keeps its own internal `apache-arrow@17`; that is fine and separate — it exchanges only raw IPC bytes with us, never Arrow objects.

**Vendored Perspective** (`public/perspective/`, built by `./build-perspective.sh`): cupola does **not** consume `@perspective-dev/*` from npm. It loads a locally built fork carrying patches upstream does not have — DuckDB Arrow coercion for hugeint/uuid/timetz/interval/bignum/bit, all dictionary key widths, `Int64` preservation, and the `view_collapse`/`view_expand` handler-trait methods that `ViewTraversal` in `perspective-duckdb-handler.ts` depends on. The fork is `~/Development/perspective` branch `duckdb-type-support-v5` (rebased onto upstream `v5.1.0`, pushed to the `query-farm` remote). To move to a newer upstream, rebase that branch and re-run the script.

Five things bite, all of which report the wrong cause:

- **The staging layout mirrors the npm package layout (`<pkg>/dist/cdn` + `<pkg>/dist/wasm`) and must not be flattened.** Each bundle finds its siblings relative to its own URL: `perspective-viewer.js` fetches `../wasm/perspective-viewer.wasm`, and `perspective.js` rewrites `.../client/dist/cdn/…` → `.../server/dist/wasm/…`, falling back to `../../../server/dist/wasm/…`. Flat, the viewer 404s (surfacing as `WebAssembly.compile(): BufferSource argument is empty`) and the server wasm is requested from the **origin root**. Cupola vendored these flat until the v5 upgrade, which is why it broke.
- **`Missing perspective-client.wasm` is a red herring.** `worker()` never fetches a client wasm — it reads `__wasm_module__` off the registered `<perspective-viewer>` class. The viewer ends in a top-level `await init_client(fetch(...))` which *swallows* a failed load ("Stage 0 wasm loading failed, skipping"), so the import still resolves and the element is silently never defined. Any problem loading `viewer/dist/wasm/perspective-viewer.wasm` surfaces as this error. **Check that file's URL first.**
- **`.gitignore` needs its `!public/perspective/**/dist/` negation.** The blanket `dist/` rule matches a directory named `dist` at any depth, so without it every vendored artifact is invisible to git — `git status` shows only the deletion of whatever was there before and none of the replacements, and a commit ships a broken app while all local tests stay green (Astro copies `public/` from disk regardless).
- **`viewer-charts` replaced `viewer-d3fc`** in the 4.5 plugin-API change, which also retired `viewer-openlayers`; both packages were deleted upstream. Loading the d3fc name 404s and rejects `ensurePerspectiveLoaded()`, taking out **both** Perspective paths.
- **Every shipped bundle still ends in `//# sourceMappingURL=<name>.js.map` even though `build-perspective.sh` deletes the `.map` files.** Devtools fetches that URL unconditionally on script load, regardless of whether the app ever references it — so a plain `.map` delete just turns "no source map" into a 404 in the console for `perspective.js`, `perspective-viewer.js`, `perspective-viewer-datagrid.js`, `perspective-viewer-charts.js`, and `perspective-server.worker.js` on every Perspective load. Harmless (Perspective itself works fine either way), but noisy enough to look like a real regression. The staging script strips the trailing `sourceMappingURL` comment line right after deleting the maps — if it reappears, the strip step didn't run against a newly-copied file.

Two build prerequisites fail with errors pointing elsewhere, so `build-perspective.sh` encodes them: `rust/perspective-client/src/rust/proto.rs` is **gitignored and generated** (a stale one gives ~56 "struct X has no field named Y" errors in files you never touched — regenerate with `PROTOC=… --features generate-proto`), and `PACKAGE` must include `metadata`, which emits the ts-rs bindings the client's `.d.ts` re-exports `Features` from (omit it and the Rust builds fine, then `tsc` fails with `Cannot find module '.../ts-rs/ColumnType.d.ts'`).

**Memory64 server binary.** `build-perspective.sh` sets `PSP_WASM64=1` so `rust/perspective-server/build.mjs` also produces `perspective-server.memory64.wasm` alongside the default wasm32 one (unset builds wasm32 only; `PSP_WASM64=only` would build *only* wasm64, dropping the wasm32 fallback needed for hosts without it — never use `only` here). `perspective.cdn.ts` already registers both and prefers wasm64 whenever `host_supports_memory64()` is true (Chrome 133+, Firefox 134+ by default at time of writing; Safari has no shipped support), raising the heap ceiling from 4GB to 16GB for large result sets with "some engine performance cost" per the fork's own registration doc comment. Before this, cupola never built the memory64 artifact at all, so every browser silently ran wasm32 regardless of what it supported — the failure mode was `Abort(): malloc of size N failed` for N around 2^31 once a result set approached wasm32's ceiling (a much rarer, later-stage cousin of the `arrow::Type::EXTENSION` abort in `perspective-extension-coerce.ts`'s doc comment — same C++ engine, different resource limit). A missing memory64 build isn't an error at either the build or the staging step — `select_server_wasm` falls back to wasm32 with a console warning, which is exactly the 404-then-fallback breadcrumb that looked alarming but was actually expected before this file existed.

**Two Perspective code paths, one container.** `ui.showPerspective(arrowBuffer)` loads a **static Arrow snapshot** (`perspectiveWorker.table()`) — driven by the shell's `.perspective` and the editor's "Open in Perspective". Selecting a table and opening the Perspective tab instead starts the **virtual server** (`VgiDuckDBHandler`), which compiles pivots to SQL against DuckDB-WASM. They share a DOM container and module-global worker but nothing else — the static path renames nothing while the virtual server maps `_`→`-` in column names, and only the virtual server supports grouping. Each has its own spec (`perspective.spec.ts`, `perspective-virtual-server.spec.ts`); the virtual-server one had no coverage until v5 broke it.

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
| `aiModel` | `"claude-sonnet-4-6"` | Claude model for AI agent (retired IDs auto-migrated on load via `RETIRED_MODEL_REPLACEMENTS` in `settings.tsx`) |
| `aiMaxToolRounds` | `20` | Max tool-use rounds per AI conversation |
| `aiMaxTokens` | `16384` | Max output tokens per AI request. Clamped to the selected model's own ceiling by `clampMaxTokens` in `src/lib/ai/model-limits.ts` — Haiku caps at 64K, Sonnet/Opus at 128K, and exceeding a model's ceiling is a 400. Was hardcoded at 4096, which truncated long `tool_use` blocks (large Vega specs) mid-JSON. |
| `aiChartFeedback` | `true` | Feed rendered chart PNG back to the agent so it can iterate |
| `aiTelemetry` | `true` | Send AI conversation analytics to Sentry (user opt-out) |

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

For end-to-end work, test with Playwright (or Playwright MCP) against a running VGI server:
```bash
# Start any VGI server (no auth for testing), e.g.
cd ~/Development/vgi-albemarle-gis && ./run-local-noauth.sh   # :9003

# Start frontend dev server
cd ~/Development/vgi-web-frontend && bun run dev

# Test in browser
http://localhost:4321/?service=http://localhost:9009
```

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

## VGI Dependencies

Both VGI clients use exact published npm releases, making local and CI builds
self-contained:
- `vgi` → npm alias for `@query-farm/vgi`
- `@query-farm/vgi-rpc` → published `@query-farm/vgi-rpc`

A third sibling is needed only to **rebuild** Perspective, not to build or run cupola:
- `~/Development/perspective` → the Query-farm fork, branch `duckdb-type-support-v5`. Consumed as prebuilt artifacts committed under `public/perspective/`, so a normal `bun run build` does not need it. See "Vendored Perspective" above and `./build-perspective.sh`.
