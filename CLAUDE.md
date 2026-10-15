# CLAUDE.md

**Cupola** (`@query-farm/cupola`) — standalone web frontend for browsing VGI (Vector Gateway Interface) database catalogs. Connects to any VGI HTTP server and displays schemas, tables, views, and functions in a sidebar tree with detail panels. Includes an embedded DuckDB-WASM SQL shell, AI data analysis agent with charting, Evidence reports, notebooks and pivot tables (Perspective). Built with Astro + React + ShadCN/UI + Tailwind CSS.

Designed to be shared across all VGI implementations (Python, TypeScript, Go). Hosted on a Cloudflare Worker with assets served from R2 (plus a Docker/Caddy kit for self-hosted Azure deployments). VGI servers redirect browsers to this frontend with `?service={url}`.

## Commands

```bash
bun install                         # install dependencies
bun run dev                         # dev server (http://localhost:4321)
bun run build                       # production build
bun run preview                     # preview production build
bun run check                       # types, including tests/ (publish aborts on it)
bun run test                        # unit tests (tests/unit/*.test.ts)
bun run test:e2e                    # Playwright e2e (tests/*.spec.ts)
bunx --bun shadcn@latest add <component> --yes
./build-perspective.sh [--stage-only]   # rebuild the vendored Perspective fork
./publish.sh ["msg" | --skip-commit]    # publish (bump package.json version first)
```

Always test against a running VGI server: `http://localhost:4321/?service=http://localhost:9009` (start one with `./test-worker/run.sh`). Without `?service=` and without a workspace, the welcome / connect page is shown. **After bumping the version, restart `bun run dev`** — `base` is `/v{version}/`, computed at startup.

## Stack

Astro 6 · React 19 (`client:load` islands) · ShadCN/UI (`src/components/ui/`, generated — do not edit by hand) · Tailwind CSS v4 · TanStack Table · xterm.js · DuckDB-WASM (`@haybarn/haybarn-wasm`) with the VGI extension · Perspective (a **locally built fork** vendored in `public/perspective/`, no npm dependency) · Vega-Lite · Evidence (Svelte) · Sentry · `vgi/client` (browser-safe VGI RPC client) · Bun.

## Rules that apply everywhere

- **Arrow comes only from `@query-farm/apache-arrow`** — never bare `apache-arrow`, never a CDN. Unit tests too. (`vgi-and-arrow.md`)
- **Browser-only imports**: use `vgi/client` and `@query-farm/vgi-rpc/connect`, never the packages' Node entry points.
- **Import VGI catalog types from `./vgi-catalog-types` (or `./service`), not `vgi/client`** — the wire's schema `path` is flattened to a name once, at that boundary.
- **SQL string literals vs identifiers**: `quoteLiteral()` for VALUES, `quoteIdent()` for NAMES (both in `src/lib/duckdb-query.ts`). Mixing them fails silently: `WHERE database_name = "memory"` is a column reference, and callers that treat a failed query as "not found" swallow the Binder Error.
- **Never splice option text into ATTACH SQL**; `buildAttachSql` is the only builder. (`attach-options.md`)
- **Secrets never go into a workspace record, share link, snippet, log line or Sentry.** (`attach-options.md`, `observability.md`)
- **Storage keys are a contract**: `vgi-frontend-settings` and the other keys in `settings-and-storage.md` must not be renamed, or users lose data.
- **Catalog aliases are assigned once and never recomputed** — they are the SQL contract saved reports are written against. (`workspaces.md`)
- **The AI agent's prompt must stay byte-stable** (nothing mutable in `system`, history append-only), or prompt caching breaks silently. (`ai-agent.md`)

## Topic notes (`.claude/rules/`)

Detailed design notes live in `.claude/rules/*.md`. Each declares `paths:` globs and is loaded automatically when you work on matching files; read one directly when a task touches its area without opening those files.

| File | Covers |
|------|--------|
| `architecture.md` | Annotated source tree |
| `url-params.md` | Every `?query` / `#fragment` parameter, hash routing |
| `vgi-and-arrow.md` | Browser-safe VGI imports, schema paths, node stubs, single Arrow, Arrow→DuckDB types, VGI npm deps |
| `duckdb-engine.md` | Lossless Arrow config, terminal readiness, query cancellation, shell bridges, eager boot |
| `attach-options.md` | Structured ATTACH options, legacy migration, secrets |
| `workspaces.md` | Multi-catalog (phase 1), workspaces (phase 2), workspace manager (3A) |
| `workspace-files-alias-rename.md` | Workspace files & DuckDB scripts (3B), alias rename, report `requires`, ⌘K palette |
| `editor-and-sidebar.md` | Sidebar + Inspector, query history & revisions, column stats, grid column sizing |
| `perspective.md` | Vendored fork, build gotchas, memory64, static vs virtual-server paths |
| `evidence-reports.md` | Evidence metadata, report agent, parameters/drilldown, report files, revisions, autosave, profiling |
| `evidence-pdf.md` | Typst PDF export, component catalog tests, maplibre pin |
| `evidence-sandbox.md` | Sandboxed `html` / `custom_map` / `custom_echart` runtimes |
| `tags.md` | Reserved `vgi.*` tag vocabulary |
| `ai-agent.md` | Prompt-cache stability, thinking blocks |
| `settings-and-storage.md` | Settings table, storage keys, model-ID checklist |
| `theme-and-auth.md` | Color theme, OAuth flow |
| `observability.md` | Sentry (browser, worker, gen_ai spans, source maps) |
| `testing.md` | Test worker, env vars, parallelism, extension boot, Evidence test service, `.test_formats` |
| `publishing.md` | R2/Worker deployment, error page, CI release |

Longer design docs are in `docs/` (`multi-catalog.md`, `evidence-integration.md`, `notebooks.md`, …).
