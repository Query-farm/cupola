---
paths:
  - "publish.sh"
  - "worker/**"
  - "wrangler.jsonc"
  - ".github/**"
  - "scripts/publish-credentials.sh"
  - "Dockerfile"
  - "Caddyfile"
  - "build-image.sh"
---

# Publishing and deployment

## URL scheme (Worker `worker/index.ts` + R2, `wrangler.jsonc`)
- `/` → current HTML, no-store.
- `/latest/` and versioned document URLs → 302 → stable document URLs (fragments inherit).
- `/v{version}/*` → immutable assets from R2, edge-cached (`caches.default`).
- R2 bucket `cupola-assets` bound as `ASSETS_BUCKET`. `/oauth-callback.html` is stable and unversioned (Entra SPA redirect URI).
- `astro.config.mjs` `base: /v{version}/`; `BASE_PATH=/` for flat Docker/Azure. Haybarn wasm + VGI extension wasm staged into `dist/haybarn/`.

## Publishing
1. Bump `version` in `package.json`.
2. `./publish.sh` (`--skip-commit` if already committed).
- `_latest` promotion is the last step; never pushes a tag. Rollback/retention: README.
- `CUPOLA_HOSTED_RELEASES=1`: stable document URLs + update notice; assets stay versioned.

## Error page (`worker/error-page.ts`)
- Variants: `outdated-version` (404, `/v{semver}/` has no `index.html`), `not-found` (404), `not-deployed` (503, no `_latest`). Chosen by probing `v{version}/` after the lookup fails.
- HTML only when `wantsHtml()` (`Accept: text/html`); missing `.js`/`.wasm` stays a plain 404.
- Redirect is client-side (`location.replace("/" + location.search + location.hash)`) so fragments survive and Back skips the dead URL.
- Loop guard: `cupola-error-redirected` sessionStorage sentinel allows one auto-redirect, then a manual button. 8s countdown cancels on keypress/scroll/pointer. `not-deployed` never auto-redirects.
- Styling inlined (`global.css` token hexes + dark block) and replays `Layout.astro`'s pre-paint script (`vgi-theme-cache`). Don't copy `public/oauth-callback.html`'s stale palette.
- Logo `/cupola-icon.png`, unversioned, not inlined (not `cupola-icon.svg`); `onerror` hides it for the empty-bucket 503.
- All error responses `Cache-Control: no-store`.

## CI (`.github/workflows/release.yml`, tag-driven)
- Secrets (GitHub `production` environment): `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (→ `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, write to `cupola-assets`), `CLOUDFLARE_API_TOKEN`, `SENTRY_AUTH_TOKEN` (optional, source maps).
- `scripts/publish-credentials.sh` validates credentials before install and before `publish.sh` commits/builds. CI needs explicit credentials. Local defaults to AWS profile `cupola` and Wrangler login; explicit AWS credentials clear any profile.
