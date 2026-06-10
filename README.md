# Cupola

A standalone web frontend for browsing VGI (Vector Gateway Interface) database catalogs. Cupola connects to any VGI HTTP server and presents its schemas, tables, views, and functions in a navigable catalog browser — with an embedded SQL shell, pivot tables, and an AI data analysis agent built in.

Designed to be shared across all VGI server implementations (Python, TypeScript, Go). VGI servers redirect browsers to the hosted frontend with `?service={url}`.

## Features

- **Catalog browser** — sidebar tree of schemas, tables, views, functions, and macros with searchable navigation, detail panels, column statistics, and on-demand column profiling
- **Embedded SQL shell** — DuckDB-WASM running in the browser with the VGI extension, an xterm.js terminal, tab completion, session persistence, and dot commands
- **AI data analysis** — Claude-powered agent that can run SQL, inspect schemas, and answer questions about your data (bring your own Anthropic API key)
- **Pivot tables** — Perspective-based data grids backed directly by DuckDB-WASM
- **Data preview** — paginated table browsing, geometry (WKB) visualization, example queries, and Markdown descriptions via VGI tags
- **Deep linking** — selection state encoded in the URL hash so views can be shared
- **OAuth / PKCE** — works with VGI servers that require authentication, including per-catalog identity
- **Theming** — custom color themes loadable via `?theme=<url>`, with a live editor at `/theme-builder`

## Stack

- [Astro](https://astro.build) + [React](https://react.dev) — static site with React islands
- [ShadCN/UI](https://ui.shadcn.com) + [Tailwind CSS](https://tailwindcss.com) — components and styling
- [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview.html) — in-browser SQL engine
- [Perspective](https://perspective.finos.org) — pivot tables and data grids
- [xterm.js](https://xtermjs.org) — terminal emulator for the SQL shell
- [Bun](https://bun.sh) — package manager and runtime
- Hosted on Cloudflare Pages with versioned assets served from R2

## Getting Started

```sh
# Install dependencies
bun install

# Start the dev server at http://localhost:4321
bun run dev
```

Cupola needs a running VGI server to talk to. Point it at one with the `service` query parameter:

```
http://localhost:4321/?service=http://localhost:9003
```

Without `?service=`, a welcome / connect page is shown.

## Commands

| Command           | Action                                       |
| :---------------- | :------------------------------------------- |
| `bun install`     | Install dependencies                         |
| `bun run dev`     | Start local dev server at `localhost:4321`   |
| `bun run build`   | Build the production site to `./dist/`       |
| `bun run preview` | Preview the production build locally         |
| `bun run test`    | Run unit tests                               |
| `./publish.sh`    | Publish a new version (build, upload to R2, deploy) |

## URL Parameters

| Parameter | Purpose |
|-----------|---------|
| `?service=<url>` | VGI server base URL to connect to |
| `?attach_options=<sql>` | Extra options spliced into the DuckDB `ATTACH` statement |
| `?theme=<url>` | URL of a theme JSON file (colors, logo, terminal theme) |
| `?fresh` | Clear any saved DuckDB session snapshot for this service |
| `#ai_key=<key>` | Anthropic API key for the AI agent (stripped from the URL after use) |
| `#/schema/<s>/table/<t>` | Deep link to a catalog selection |

## Deployment

Assets are served from Cloudflare R2 via a Pages Function with a versioned URL scheme (`/v{version}/...`, with `/latest/` redirecting to the current version). To publish:

1. Bump `version` in `package.json`
2. Run `./publish.sh`

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright © 2026 Query Farm LLC — [https://query.farm](https://query.farm)
