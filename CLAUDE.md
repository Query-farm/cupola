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
| `#sql=...` / `#sql_z=...` | SQL for a shared query link. Opens in a **new Query Editor tab, made active but not executed** — the recipient chooses when to run it. This is what the editor toolbar's Share button emits: a fragment never reaches the worker's request log, the redirect chain's `Location` headers, or an outbound `Referer`, and share links routinely carry literals (a table function's `api_key :=` argument, an email in a `WHERE`) the author never thought of as secret. `sql_z` is raw-deflate + base64url, used automatically past `AUTO_COMPRESS_THRESHOLD` (1500 chars) or forced via `buildShareQueryUrl({compress: true})`; a corrupt token decodes to null rather than throwing. Consumed and stripped by `consumeSharedSql()` (other fragment keys preserved); links are built by `buildShareQueryUrl()` in `src/lib/share-query.ts`. Connection context (`service`, `attach_options`) stays in the query string. **Not** a Sentry hiding place — the browser SDK captures `location.href` hash included, which is why `sentry-scrub.ts` scrubs both halves. |
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
- **Perspective** — pivot table / data grid visualization
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
.github/workflows/
  publish.yml                # Manual-dispatch CI publish (inactive until secrets are set)
```

## Key Design Decisions

**Browser-only imports**: The main `@query-farm/vgi-rpc` and `vgi` packages include Node.js code. The frontend uses:
- `vgi/client` — browser-safe entry point (no node:fs, node:os)
- `@query-farm/vgi-rpc/connect` — aliased in `astro.config.mjs` to the source client module

**Node stubs** (`src/lib/node-stubs.ts`): Apache Arrow's Node.js I/O modules reference `node:stream` etc. These stubs provide minimal class shells so `class X extends Readable` doesn't throw. They are aliased in `astro.config.mjs`.

**Arrow-to-DuckDB types**: Column types from the VGI server are Arrow types (Utf8, Int64, Date32). `arrow-to-duckdb.ts` converts these to DuckDB display names (VARCHAR, BIGINT, DATE). Checks `ARROW:extension:name` metadata for `geoarrow.wkb` → `GEOMETRY`.

**Hash routing**: Navigation state is encoded in the URL hash (`#/schema/property/table/parcels`) so users can share deep links. Uses `pushState` + `popstate` for browser back/forward.

**Shell bridge** (`src/lib/shell-bridge.ts`): A typed global singleton for cross-component messaging. Holds: `query` (DuckDB query function), `worker` reference, terminal state, navigation callbacks, tab handlers (Perspective). Components subscribe to `bridge.query` availability via `onQueryChange`/`notifyQueryChange` so features like column stats can retry after the shell finishes initializing.

**Eager worker boot** (`src/lib/duckdb-worker-boot.ts`): The DuckDB WASM worker is created at CatalogApp mount time (not when the shell panel opens), so the worker is typically ready by the time the user clicks "Open SQL Shell". Pre-allocates SharedArrayBuffers for query cancellation and OAuth.

**Column stats and profiling**: `fetchColumnStats()` (in `service.ts`) queries DuckDB's `vgi_table_statistics()` for per-column min/max/nulls/distinct counts; it internally awaits `bridge.attached`, so callers like `TableDetail` can fire it immediately even before the shell finishes attaching. `ColumnProfile` provides deeper on-demand distribution analysis.

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
| `anthropicApiKey` | `""` | Claude API key for AI features |
| `aiModel` | `"claude-sonnet-4-6"` | Claude model for AI agent (retired IDs auto-migrated on load via `RETIRED_MODEL_REPLACEMENTS` in `settings.tsx`) |
| `aiMaxToolRounds` | `20` | Max tool-use rounds per AI conversation |
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
# Start VGI server (no auth for testing)
cd ~/Development/vgi-albemarle-gis && ./run-local-noauth.sh

# Start frontend dev server
cd ~/Development/vgi-web-frontend && bun run dev

# Test in browser
http://localhost:4321/?service=http://localhost:9003
```

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

**CI publishing** (`.github/workflows/publish.yml`): manual-dispatch workflow that checks out the sibling repos, runs tests, runs `./publish.sh --skip-commit`, and tags the release. Inactive until the repository secrets listed in the README's Deployment section are configured.

## Dependencies on Sibling Repos

The `package.json` references local sibling repos:
- `vgi` → `../vgi-typescript` (private repo; not published to npm)
- `@query-farm/vgi-rpc` → `../vgi-rpc-typescript` (public repo; `astro.config.mjs` aliases directly into its source)

The CI publish workflow checks these out side-by-side; locally they must exist as sibling directories.
