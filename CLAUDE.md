# CLAUDE.md

## Project Overview

Standalone web frontend for browsing VGI (Vector Gateway Interface) database catalogs. Connects to any VGI HTTP server and displays schemas, tables, views, and functions in a sidebar tree with detail panels. Built with Astro + React + ShadCN/UI + Tailwind CSS.

Designed to be shared across all VGI implementations (Python, TypeScript, Go). Hosted on Cloudflare Pages or any static host. VGI servers redirect browsers to this frontend with `?service={url}`.

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
- **vgi-typescript** (`vgi/client`) — browser-safe VGI client for Arrow IPC RPC
- **Bun** — package manager and runtime

## Architecture

```
src/
  pages/index.astro          # Single page, mounts CatalogApp
  layouts/Layout.astro       # HTML shell, fonts, favicon
  components/
    CatalogApp.tsx           # Top-level: fetches catalog, manages selection, routing
    Sidebar.tsx              # Tree view + search + settings
    Header.tsx               # Logo, catalog name, refresh, user info
    ConnectBox.tsx            # DuckDB ATTACH snippet with copy
    SettingsModal.tsx         # Settings dialog (DuckDB types, hide backing functions)
    UserInfo.tsx              # OAuth user info from JWT cookie
    tree-view.tsx             # Accordion-based tree (from mrlightful/shadcn-tree-view)
    content/
      CatalogOverview.tsx    # Default view: connect box + schema list
      SchemaDetail.tsx       # Schema: table/view/function lists
      TableDetail.tsx        # Table: columns, types, comments, constraints, FK, sample SQL
      ViewDetail.tsx         # View detail
      FunctionDetail.tsx     # Function detail
    ui/                      # ShadCN generated components (do not edit manually)
  lib/
    service.ts               # VgiClient wrapper: connect, fetch catalog/schemas/tables
    auth.ts                  # JWT cookie/fragment token extraction
    tree.ts                  # Build TreeDataItem[] from CatalogData, selection↔ID mapping
    navigation.ts            # URL hash routing, page title updates
    settings.tsx             # Settings context + localStorage persistence
    arrow-to-duckdb.ts       # Arrow type → DuckDB type name conversion
    node-stubs.ts            # Browser stubs for node:stream/zlib/crypto/fs (Apache Arrow needs these)
    utils.ts                 # cn() Tailwind class merge utility
  styles/
    global.css               # Tailwind config, VGI color theme, ShadCN variables
```

## Key Design Decisions

**Browser-only imports**: The main `@query-farm/vgi-rpc` and `vgi` packages include Node.js code. The frontend uses:
- `vgi/client` — browser-safe entry point (no node:fs, node:os)
- `@query-farm/vgi-rpc/connect` — aliased in `astro.config.mjs` to the source client module

**Node stubs** (`src/lib/node-stubs.ts`): Apache Arrow's Node.js I/O modules reference `node:stream` etc. These stubs provide minimal class shells so `class X extends Readable` doesn't throw. They are aliased in `astro.config.mjs`.

**Arrow-to-DuckDB types**: Column types from the VGI server are Arrow types (Utf8, Int64, Date32). `arrow-to-duckdb.ts` converts these to DuckDB display names (VARCHAR, BIGINT, DATE). Checks `ARROW:extension:name` metadata for `geoarrow.wkb` → `GEOMETRY`.

**Hash routing**: Navigation state is encoded in the URL hash (`#/schema/property/table/parcels`) so users can share deep links. Uses `pushState` + `popstate` for browser back/forward.

**Settings**: Stored in localStorage (`vgi-frontend-settings`). Currently: show DuckDB types (default true), hide table-backing functions (default true).

## Color Theme

VGI green palette defined in `src/styles/global.css`:
- Background: `#faf8f0` (warm cream)
- Primary: `#2d5016` (forest green)
- Accent: `#4a7c23` (leaf green)
- Muted: `#6b6b5a`
- Border: `#f0ece0`
- Card: `#ffffff`

## OAuth / Authentication

When a VGI server has OAuth PKCE enabled:
1. The frontend reads the JWT token from the URL fragment (`#token=...`) or `_vgi_auth` cookie
2. Token is sent as `Authorization: Bearer` header on all RPC calls
3. `UserInfo.tsx` decodes the JWT payload to display email/avatar
4. Token from fragment is cached in memory and cleaned from the URL

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
- `/v0.3.25/*` → immutable versioned assets from R2

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

## Dependencies on Sibling Repos

The `package.json` references local sibling repos:
- `vgi` → `../vgi-typescript`
- `@query-farm/vgi-rpc` → `../vgi-rpc-typescript`

For CI/deployment, these need to be published packages or workspace links.
