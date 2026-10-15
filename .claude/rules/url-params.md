---
paths:
  - "src/lib/url-params.ts"
  - "src/lib/auth.ts"
  - "src/lib/share-query.ts"
  - "src/lib/navigation.ts"
  - "src/lib/theme.ts"
  - "src/lib/workspace/codec.ts"
  - "src/lib/workspace/session.ts"
  - "src/components/CatalogApp.tsx"
  - "tests/unit/navigation.test.ts"
  - "tests/unit/url-params.test.ts"
---

# URL parameters and hash routing

All readers live in `src/lib/url-params.ts`. VGI server redirects may set any of these.

| Key | Contract |
|-----|---------|
| `?service` | **Frozen: exactly one catalog** (the service's first, or the Grainlift target), aliased under the server's catalog name. Opens the service's untitled workspace; never changes a named one (banner offers Open/Add to). A workspace wins if both present; neither → welcome page. |
| `?local_ws` | Workspace id in this browser. Set only by the app (consented `#ws=`, rename, picker change) via `replaceState`, keeping the hash. Falls back to sessionStorage `cupola.session-workspace.v1:<id>` for an unconsented link. Share emits `#ws=`, never this. |
| `?attach_options` | Legacy text, **never spliced into SQL**: plain literals apply; other values need a consent screen and DuckDB's parse of `SELECT CAST((<expr>) AS VARCHAR)` passing the constant allowlist; refused ones are dropped and reported. Overrides stored values; saved once specs are known (secrets to `cupola.catalog-secrets.v1`), then **stripped**. Empty value clears saved options + secrets. Share writes back non-secret `name 'text'` only. |
| `?ai_key` | → `settings.anthropicApiKey`, persisted, **stripped via `replaceState`**; one-shot, overwrites. Beats `#ai_key`. |
| `?sql` / `?sql_z` | Server-composed share links. Beats the fragment form. |
| `?target` | Grainlift target (`grainlift+https://`, `grainlift://` = HTTPS, `grainlift+http://`, `grainlift+iroh://<endpoint-id>`) → `target '...'`, saved with the service. OAuth gateways get PKCE sign-in; bearer + refresh ride on the ATTACH. |
| `?name` | Grainlift alias (default: target). |
| `?theme` | Theme JSON URL, cached in localStorage for pre-paint (`theme.ts`, `Layout.astro`). |
| `#token=&refresh_token=&token_endpoint=&client_id=&client_secret=&use_id_token=` | OAuth bundle (`auth.ts`); token cached in memory; **only these keys** stripped, others kept for their readers. |
| `#ai_key=` | Preferred form (not sent to servers); stripped, other keys kept. |
| `#sql=` / `#sql_z=` | What Share emits (avoids logs, `Location`, `Referer`). Opens a new active tab, **not executed**. `sql_z` = raw-deflate + base64url past 1500 chars (`AUTO_COMPRESS_THRESHOLD`) or `compress: true`; corrupt → null. `consumeSharedSql()` stashes it in sessionStorage `vgi-pending-share-sql` so an auth redirect can't eat it; cleared only via `onPendingConsumed`. Sentry captures the hash, so `sentry-scrub.ts` scrubs both halves. |
| `#ws=<token>` | Workspace link: `{format: "cupola-workspaces", version: 1, workspaces: [{id?, name?, catalogs: [{id?, url, catalogName, alias?, options?, target?, dataVersionSpec?}], defaultCatalogId?, defaultSchema?}]}`, deflate + base64url (`workspace/codec.ts`). **No secrets** (credential-named options dropped). Normalised once (aliases assigned once), stored, swapped for `?local_ws=`; consent screen before any attach. First workspace opens. May sit beside `sql=` and `ai_key=`. |
| `#/catalog/<alias>/schema/<s>/table/<t>` (`view`/`function`/`macro`; `#/catalog/<alias>` root) | Selection routing (`navigation.ts`, `pushState` + `popstate`). Legacy `#/schema/…` resolves against the default catalog. |
| `#prefill=<service-url>` | Prefills `ConnectForm` (and saved options) without connecting; cleared after use. |

- Every selection carries its catalog (`resolveSelection`), so Back can't restore a memory table into the VGI catalog. `tests/unit/navigation.test.ts` covers the encodings.
