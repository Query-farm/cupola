---
paths:
  - "src/**"
  - "worker/**"
  - "tests/**"
  - "test-worker/**"
---

# Source layout

```
src/
  pages/
    index.astro              # mounts CatalogApp
    sign-out.astro           # OAuth sign-out + IdP logout
    theme-builder.astro      # /theme-builder
    brand-preview.astro      # logo/brand preview
  layouts/Layout.astro       # HTML shell, pre-paint theme
  components/
    CatalogApp.tsx           # top level: catalog fetch, selection, routing
    DuckDBShell.tsx          # shell panel, Perspective/preview hosts
    Sidebar.tsx              # tree + search + settings
    ServiceSwitcher.tsx      # workspace picker: catalogs, status, ⋯ menu, attach, share
    workspace/               # CatalogChip, AttachCatalogForm, CatalogOptionsDialog
    ConnectBox.tsx           # ATTACH snippet
    AskAIChat.tsx            # AI chat panel
    tree-view.tsx            # accordion tree (mrlightful/shadcn-tree-view)
    content/                 # detail panels (Table/View/Function/Macro detail, DataGrid, …)
    chat/                    # AI chat sub-components
    ui/                      # ShadCN generated: do not edit manually
  lib/
    service.ts               # VgiClient wrapper (catalog, stats)
    url-params.ts            # single source of truth for URL readers
    auth.ts                  # JWT cookie/fragment tokens
    tree.ts                  # CatalogData → TreeDataItem[], selection↔ID
    tree-expansion.ts        # pure expand/collapse logic
    navigation.ts            # hash routing (#/catalog/<alias>/…), page title
    workspace/               # multi-catalog: spec, aliases, codec (#ws=), session,
                             #   load, store (+ overlay), migrate, legacy-scope, catalog-colors
    share-query.ts           # ?sql= / ?sql_z= codec + builder
    attach/                  # structured ATTACH: options (builder, secrets), legacy-options
                             #   (AST allowlist), prepare (TRY_CAST), specs, secret-store,
                             #   connection, form, error-detail, attach-catalog (one at a time)
    settings.tsx             # settings context + localStorage
    utils.ts                 # cn()

    shell-bridge.ts          # typed bridge globals
    duckdb-worker-boot.ts    # eager worker boot at CatalogApp mount
    duckdb-query.ts          # every Arrow decode routes here
    shell-init.ts            # terminal, ATTACH flow, read loop
    shell-commands.ts        # dot commands (.ai dispatched in shell-init → shell-ai-mode)
    shell-input.ts           # tab completion, Ctrl+R search
    shell-table-renderer.ts  # box/line mode rendering

    reports/                 # used by Evidence: $parameter binder, semantic*, Add to report
    evidence/                # report parameters, drill, filter-summary
    evidence/typst/          # PDF export: extract (DOM→model), emit (→Typst), template,
                             #   charts (ECharts→SVG), css-color, compiler, export-pdf

    ai-agent.ts              # SSE loop, tools, Sentry gen_ai spans
    ai-fetch.ts              # Anthropic retry policy (429/529)
    ai-history.ts            # dangling tool_use repair
    ai-loop-guard.ts         # repeated-tool-call breaker
    ai-tool-executor.ts      # tools shared by chat + terminal
    ai-telemetry.ts          # gen_ai attributes + opt-out
    query-results.ts         # Arrow→JSON + cache for the agent
    tool-input.ts            # streamed input_json_delta parsing
    chart-rows-store.ts      # rows for render_chart
    markdown-ansi.ts         # streaming Markdown → ANSI

    column-profiler.ts       # column distributions
    format.ts                # grid/terminal value formatting
    function-info.ts         # VGI function arg metadata (vgi_doc, defaults, constraints)
    tags.ts                  # reserved vgi.* tags, getTag alias fallback, filters
    duckdb-catalog.ts        # attached-database introspection for sidebar
    perspective-duckdb-handler.ts  # Perspective virtual server over DuckDB
    oauth-client.ts          # browser PKCE client
    theme.ts                 # ?theme= loading + cache
    sentry-scrub.ts          # scrub secrets before Sentry
    recent-services.ts       # pre-workspace recents: read-only, migrated at boot
    node-stubs.ts            # node:stream/zlib/crypto/fs stubs
  styles/global.css          # Tailwind, theme, ShadCN vars
worker/index.ts              # Cloudflare Worker: versioned R2, edge cache, /latest, Sentry
tests/
  unit/                      # bun test
  *.spec.ts                  # Playwright (perspective.spec = static path,
                             #   perspective-virtual-server.spec = DuckDB path)
test-worker/                 # Python VGI worker, synthetic cupola_test; dev-only
.github/workflows/           # ci.yml, release.yml (tag-driven), release-cleanup.yml
```
