# Azure Container Apps deployment (flat single-version build)

This documents how to package the Cupola frontend as a Docker image and run it
on Azure Container Apps, **in addition to** (not replacing) the existing
Cloudflare Pages/R2 deployment. It was added for a customer who wants to host
the frontend on Azure.

## TL;DR

```bash
./build-image.sh myregistry.azurecr.io/cupola:0.4.77   # build + stage wasm + docker build
docker push myregistry.azurecr.io/cupola:0.4.77
az containerapp create -n cupola -g <rg> --environment <env> \
  --image myregistry.azurecr.io/cupola:0.4.77 \
  --target-port 80 --ingress external
```

## Why this works the way it does

### It's a static site
The Astro build is 100% static (no SSR). The Cloudflare **Worker**
(`worker/index.ts`) is *only* a static file server in front of R2. So hosting
elsewhere is just "serve `dist/` with the right headers." No app logic moves.

### The critical part: cross-origin isolation headers
DuckDB-WASM's COI/threads build, query cancellation, the AI agent, and the
OAuth popup→worker code routing all depend on `SharedArrayBuffer`, which the
browser only enables when the page is **cross-origin isolated**. That requires
these headers on every response:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Without them the SQL shell silently fails to initialize. The `Caddyfile` sets
them globally, matching what `worker/index.ts` (`respond()`) sends in
production.

> Note: the legacy `public/_headers` file uses COEP `credentialless`, but the
> live Worker uses `require-corp`. We matched `require-corp` because that's
> what's proven in production. `credentialless` is the more lenient fallback if
> cross-origin subresource loads become a problem.

### Flat build (`base: '/'`)
The normal build version-prefixes every asset path (`base: /v{version}/`) for
content-isolated R2 releases. A single-tenant Azure deployment doesn't need the
multi-version URL scheme (Container Apps revisions already give zero-downtime
rollback), so we build flat:

```bash
BASE_PATH=/ bun run build
```

`astro.config.mjs` reads `process.env.BASE_PATH` and falls back to the
versioned base when unset, so the Cloudflare publish path is unchanged. The app
references `import.meta.env.BASE_URL` everywhere (not hardcoded version
strings), so a flat base resolves cleanly at root.

### The wasm-staging trap
`astro build` does **not** emit the DuckDB wasm engine. The
`AsyncDuckDB` sub-worker fetches `duckdb-{coi,eh,mvp}.wasm`, the worker JS
bundles, and the VGI extension wasm from `${BASE_URL}haybarn/...` at runtime.
`publish.sh` stages these into `dist/haybarn/` before syncing to R2 — so a
naive Dockerfile built straight off `astro build` produces a site where the SQL
shell silently fails to boot.

`build-image.sh` replicates that staging:
- copies `duckdb-*.wasm` + worker bundles from
  `node_modules/@haybarn/haybarn-wasm/dist` into `dist/haybarn/`
- downloads the 3 VGI extension wasm variants (`wasm_mvp`, `wasm_eh`,
  `wasm_threads`, version `v1.5.3`) from `haybarn-extensions.query.farm` into
  `dist/haybarn/extensions/` so the shell has a local mirror

If the haybarn package version is bumped in `package.json`, update
`HAYBARN_EXT_VERSION` in `build-image.sh` to match.

### The `/npm/*` proxy
`DuckDBShell.tsx` loads `apache-arrow` and `xterm-readline` as jsdelivr `+esm`
bundles. Those bundles' internal imports resolve to `/npm/...` against **our**
origin, so the server must proxy `/npm/*` → `cdn.jsdelivr.net` (with
`Access-Control-Allow-Origin: *`). The Cloudflare Worker does this; the
`Caddyfile` `handle /npm/*` block does the same. Without it the SQL shell
breaks.

## Files

| File | Purpose |
|---|---|
| `build-image.sh` | Flat Astro build → stage wasm engine + VGI extension → `docker build`. Takes an optional image tag arg (default `cupola:flat`). |
| `Dockerfile` | `caddy:2-alpine` image that serves the prebuilt `dist/`. Does **not** run `bun install` (see below). |
| `Caddyfile` | Static serving + cross-origin isolation headers + `/npm` proxy + wasm MIME/long-cache. Listens on `:80` with `auto_https off`. |
| `.dockerignore` | Limits build context to `dist/` + `Caddyfile`. |
| `astro.config.mjs` | `base: process.env.BASE_PATH \|\| \`/v${pkg.version}/\`` |

### Why the image doesn't build in-container
`package.json` points the `vgi` and `@query-farm/vgi-rpc` deps at **local
sibling repos** (`../vgi-typescript`, `../vgi-rpc-typescript`) that aren't in
the Docker build context. So the bundle is built on the host (where the
siblings are linked, same as a Cloudflare publish) and the image just serves
the prebuilt `dist/`. A fully self-contained multi-stage build would first
require publishing or vendoring those two packages.

## Azure Container Apps notes
- **Target port 80.** Container Apps terminates TLS at the ingress and forwards
  plain HTTP to the container — hence `auto_https off` in the `Caddyfile`.
- **Revisions** provide zero-downtime deploys/rollbacks, replacing the only
  operational benefit of the Cloudflare versioned-URL scheme.
- **Health probe:** the default probe on `/` returns the index `200`.

## Connecting to a VGI server
The frontend reads `?service=<vgi-url>` to know which VGI server to query.
Because the page is cross-origin isolated (`COEP: require-corp`), the
customer's **VGI server must return CORS headers** on its Arrow RPC responses
and allow the new Azure origin. This is a VGI-server config concern, not a
frontend one — it already works for the Cloudflare-hosted frontend.

## Verification performed
Built the image and confirmed against a running container:
- COOP/COEP/CORP present on `/`, `/_astro/*` JS, and wasm responses
- `duckdb-coi.wasm` served as `application/wasm` (~32 MB), COI worker JS, and
  the VGI extension wasm (~2.4 MB) all `200`
- flat asset paths with zero leftover `/v{version}/` references
- extensionless routes (`/sign-out`) and `/oauth-callback.html` resolve `200`
- `/npm/*` proxies to jsdelivr with `Access-Control-Allow-Origin: *`
- final image size ~207 MB
