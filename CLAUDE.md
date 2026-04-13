# CLAUDE.md

## Project Overview

Standalone web frontend for browsing VGI (Vector Gateway Interface) database catalogs. Connects to any VGI HTTP server and displays schemas, tables, views, and functions in a sidebar tree with detail panels. Includes an embedded DuckDB-WASM SQL shell, AI data analysis agent, map visualization (Kepler.gl), and pivot tables (Perspective). Built with Astro + React + ShadCN/UI + Tailwind CSS.

Designed to be shared across all VGI implementations (Python, TypeScript, Go). Hosted on Cloudflare Pages with assets served from R2. VGI servers redirect browsers to this frontend with `?service={url}`.

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

## Stack

- **Astro 6** — static site framework, outputs to Cloudflare Pages
- **React 19** — UI components via `client:load` islands
- **ShadCN/UI** — component library (Card, Table, Badge, Button, Input, Dialog, Switch, etc.)
- **Tailwind CSS v4** — styling via `@tailwindcss/vite` plugin
- **TanStack Table** — column sorting, filtering, expansion in ColumnsTable
- **xterm.js** — terminal emulator for the DuckDB SQL shell (loaded from CDN)
- **DuckDB-WASM** — in-browser SQL engine with VGI extension
- **Kepler.gl** — geospatial map visualization
- **Perspective** — pivot table / data grid visualization
- **vgi-typescript** (`vgi/client`) — browser-safe VGI client for Arrow IPC RPC
- **Bun** — package manager and runtime

## Architecture

```
src/
  pages/
    index.astro              # Main page, mounts CatalogApp
    sign-out.astro           # OAuth sign-out with IdP logout
    theme-builder.astro      # Live theme color editor at /theme-builder
  layouts/Layout.astro       # HTML shell, fonts, favicon
  components/
    CatalogApp.tsx           # Top-level: fetches catalog, manages selection, routing
    DuckDBShell.tsx          # SQL shell: xterm.js terminal, ATTACH, session mgmt, tabs
    Sidebar.tsx              # Tree view + search + settings
    Header.tsx               # Logo, catalog name, refresh, user info
    ServiceSwitcher.tsx      # Service URL switcher with recent history + per-catalog identity
    ConnectBox.tsx           # DuckDB ATTACH snippet with copy
    SettingsModal.tsx        # Settings dialog (types, shell, AI config)
    UserInfo.tsx             # OAuth user info from JWT cookie
    AskAIChat.tsx            # Claude AI chat panel with streaming + tool calls
    KeplerMap.tsx            # Kepler.gl map visualization with isolated Redux store
    ErrorBoundary.tsx        # React error boundary
    ThemeBuilder.tsx         # Live theme editor with color pickers
    tree-view.tsx            # Accordion-based tree (from mrlightful/shadcn-tree-view)
    content/
      CatalogOverview.tsx    # Default view: connect box + schema list
      SchemaDetail.tsx       # Schema: table/view/function lists
      TableDetail.tsx        # Table: columns, constraints, stats, example queries
      ViewDetail.tsx         # View detail
      FunctionDetail.tsx     # Function detail
      MacroDetail.tsx        # Macro detail (scalar + table macros)
      ColumnsTable.tsx       # Sortable/filterable columns with expand for stats + profiling
      ColumnProfile.tsx      # On-demand column distribution profiling
      DataPreview.tsx        # Paginated data browser for table contents
      DataGrid.tsx           # Compact tabular display
      GeometryViewer.tsx     # WKB geometry visualization
      MemoryCatalogOverview.tsx  # View for in-memory DuckDB tables
      Breadcrumb.tsx         # Navigation breadcrumb
      ExampleQueries.tsx     # Tagged example queries display
      DescriptionSection.tsx # Markdown description rendering
      SqlCodeBlock.tsx       # SQL syntax-highlighted code block
      TagsTable.tsx          # Custom VGI tags display
    chat/                    # AI chat sub-components
      ChatInput.tsx, ChatMessageUser.tsx, ChatMessageAssistant.tsx,
      ChatMarkdown.tsx, ThinkingIndicator.tsx, SqlToolCallBlock.tsx,
      AskUserBlock.tsx, QueryResultTable.tsx
    ui/                      # ShadCN generated components (do not edit manually)
  lib/
    # Core
    service.ts               # VgiClient wrapper: connect, fetch catalog/schemas/tables/stats
    auth.ts                  # JWT cookie/fragment token extraction
    tree.ts                  # Build TreeDataItem[] from CatalogData, selection↔ID mapping
    navigation.ts            # URL hash routing, page title updates
    settings.tsx             # Settings context + localStorage persistence
    utils.ts                 # cn() Tailwind class merge utility

    # DuckDB Shell
    shell-bridge.ts          # Typed global bridge singleton for cross-component messaging
    duckdb-worker-boot.ts    # Eager worker boot at CatalogApp mount (SABs, WASM prefetch)
    duckdb-query.ts          # Shared helpers for querying DuckDB via bridge
    shell-commands.ts        # Dot-command dispatcher (.ai, .save, .load, .download, etc.)
    shell-input.ts           # Tab completion and Ctrl+R reverse history search
    shell-table-renderer.ts  # Terminal table rendering (box-mode, line-mode, cell formatting)
    shell-ai-mode.ts         # AI conversation loop in terminal with streaming ANSI
    session-store.ts         # IndexedDB session persistence (compressed DuckDB memory snapshots)
    prefetch-duckdb.ts       # Prefetch duckdb-coi.wasm bytes during page load

    # AI Agent
    ai-agent.ts              # Claude agent with tools: run_sql, read_query_results,
                             #   list_tables, describe_table, ask_user
    pricing.ts               # Claude model pricing for cost estimation
    markdown-ansi.ts         # Streaming Markdown → ANSI for xterm rendering

    # Data & Types
    arrow-to-duckdb.ts       # Arrow type → DuckDB type name conversion
    column-profiler.ts       # Column distribution analysis (numeric, string, date, geometry)
    format.ts                # Value formatting for grids/terminals (dates, BigInt, geometry)
    tags.ts                  # VGI well-known tags (example_queries, description_md, etc.)
    wkb.ts                   # WKB geometry parsing

    # Integrations
    duckdb-catalog.ts        # Introspect attached DuckDB databases for sidebar
    perspective-duckdb-handler.ts  # Perspective VirtualServerHandler backed by DuckDB WASM
    vgi-duckdb-adapter.ts    # Kepler.gl DatabaseAdapter for SQL panel

    # Auth & Identity
    oauth-client.ts          # Browser OAuth 2.0 PKCE client (Entra/IdP)
    catalog-identity.ts      # Per-catalog identity fetching

    # Theme & UI
    theme.ts                 # Theme loading from ?theme=<url>, localStorage caching
    recent-services.ts       # Recently-connected service URLs (localStorage, max 10)
    node-stubs.ts            # Browser stubs for node:stream/zlib/crypto/fs
    assert-stub.ts           # Node.js assert stub for browser compatibility
  styles/
    global.css               # Tailwind config, VGI color theme, ShadCN variables
functions/
  [[path]].ts                # Cloudflare Pages Function: versioned R2 serving, edge caching
```

## Key Design Decisions

**Browser-only imports**: The main `@query-farm/vgi-rpc` and `vgi` packages include Node.js code. The frontend uses:
- `vgi/client` — browser-safe entry point (no node:fs, node:os)
- `@query-farm/vgi-rpc/connect` — aliased in `astro.config.mjs` to the source client module

**Node stubs** (`src/lib/node-stubs.ts`): Apache Arrow's Node.js I/O modules reference `node:stream` etc. These stubs provide minimal class shells so `class X extends Readable` doesn't throw. They are aliased in `astro.config.mjs`.

**Arrow-to-DuckDB types**: Column types from the VGI server are Arrow types (Utf8, Int64, Date32). `arrow-to-duckdb.ts` converts these to DuckDB display names (VARCHAR, BIGINT, DATE). Checks `ARROW:extension:name` metadata for `geoarrow.wkb` → `GEOMETRY`.

**Hash routing**: Navigation state is encoded in the URL hash (`#/schema/property/table/parcels`) so users can share deep links. Uses `pushState` + `popstate` for browser back/forward.

**Shell bridge** (`src/lib/shell-bridge.ts`): A typed global singleton for cross-component messaging. Holds: `query` (DuckDB query function), `worker` reference, terminal state, navigation callbacks, tab handlers (Perspective, Kepler). Components subscribe to `bridge.query` availability via `onQueryChange`/`notifyQueryChange` so features like column stats can retry after the shell finishes initializing.

**Eager worker boot** (`src/lib/duckdb-worker-boot.ts`): The DuckDB WASM worker is created at CatalogApp mount time (not when the shell panel opens), so the worker is typically ready by the time the user clicks "Open SQL Shell". Pre-allocates SharedArrayBuffers for query cancellation and OAuth. Prefetched WASM bytes are transferred via `postMessage(..., [bytes])` to avoid double-fetch.

**Session persistence** (`src/lib/session-store.ts`): DuckDB WASM memory snapshots are compressed and stored in IndexedDB, keyed by service URL. Auto-saved periodically. Session restore is controlled by the `autoRestoreSession` setting (default: off). Manual restore available via `.sessions` dot command. Use `?fresh` URL param to clear a corrupted snapshot.

**Column stats and profiling**: `fetchColumnStats()` queries DuckDB's `vgi_table_statistics()` for per-column min/max/nulls/distinct counts. If the shell isn't ready yet, `TableDetail` subscribes to bridge query changes and retries. `ColumnProfile` provides deeper on-demand distribution analysis.

**Tags system**: VGI servers can attach metadata tags to tables/schemas/catalogs. Well-known tags include `vgi.example_queries` (JSON array of SQL examples), `vgi.description_md` (Markdown description), and `vgi.description_llm` (AI-facing description). Tags are filtered differently for display vs. AI agent use.

## Settings

Stored in localStorage (`vgi-frontend-settings`):

| Setting | Default | Description |
|---------|---------|-------------|
| `showDuckDBTypes` | `true` | Show DuckDB type names instead of Arrow types |
| `hideTableBackingFunctions` | `true` | Hide table-backing functions from sidebar |
| `shellFontSize` | `13` | Terminal font size |
| `autoRestoreSession` | `false` | Auto-restore last DuckDB session on load |
| `anthropicApiKey` | `""` | Claude API key for AI features |
| `aiModel` | `"claude-sonnet-4-20250514"` | Claude model for AI agent |
| `aiMaxToolRounds` | `20` | Max tool-use rounds per AI conversation |

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
3. `UserInfo.tsx` decodes the JWT payload to display email/avatar
4. Token from fragment is cached in memory and cleaned from the URL
5. The DuckDB extension handles its own PKCE flow for ATTACH — uses SharedArrayBuffer to route auth codes from a popup back to the worker thread
6. Per-catalog identity is fetched via `catalog-identity.ts` and displayed in `ServiceSwitcher`

## Testing

Test with Playwright MCP against a running VGI server:
```bash
# Start VGI server (no auth for testing)
cd ~/Development/vgi-albemarle-gis && ./run-local-noauth.sh

# Start frontend dev server
cd ~/Development/vgi-web-frontend && bun run dev

# Test in browser
http://localhost:4321/?service=http://localhost:9003
```

## Publishing & Deployment

Assets are served from Cloudflare R2 via a Pages Function (`functions/[[path]].ts`). The URL scheme is versioned:
- `/` → 302 → `/latest/`
- `/latest/` → 302 → `/v{current}/` (reads `_latest` marker from R2)
- `/v{version}/*` → immutable versioned assets from R2

**To publish a new version:**
1. Bump `version` in `package.json`
2. Run `./publish.sh` (or `./publish.sh --skip-commit` if already committed)

`publish.sh` handles: git commit/push/tag, build, upload all assets to R2 under `v{version}/`, update the `_latest` marker, and deploy the Pages Function.

**Key details:**
- `astro.config.mjs` sets `base: /v{version}/` so all emitted asset paths are versioned
- Oversized files (>25MB, e.g. WASM) are uploaded to R2 root (shared across versions)
- Normal files go under the `v{version}/` prefix in R2
- The Pages Function serves from R2 with edge caching (`caches.default`)
- `wrangler.jsonc` binds the `cupola-assets` R2 bucket as `ASSETS_BUCKET`
- `/oauth-callback.html` is served at a stable unversioned URL (Entra SPA redirect URI)

## Dependencies on Sibling Repos

The `package.json` references local sibling repos:
- `vgi` → `../vgi-typescript`
- `@query-farm/vgi-rpc` → `../vgi-rpc-typescript`

For CI/deployment, these need to be published packages or workspace links.
