---
paths:
  - "tests/**"
  - "test-worker/**"
  - "playwright*.config.ts"
---

# Testing

## Unit tests (`tests/unit/`, `bun run test`)
- Pure logic. AI helper modules (`ai-fetch`, `ai-history`, `ai-telemetry`, `sentry-scrub`, …) stay free of service/VGI imports.
- **Bun runs all files in one global scope, in platform-dependent order.** A file that stubs `window`/`history`/`fetch` must restore it in `afterAll`/`afterEach`. A leaked `window.location` made `posthog-js` throw `location is not defined` in `evidence-typst-catalog.test.ts`, on Linux only.

## E2E test worker (`test-worker/`, synthetic `cupola_test`)
```bash
./test-worker/run.sh                                           # :9009
CUPOLA_TEST_ATTACH_OPTIONS=1 PORT=9010 ./test-worker/run.sh    # cupola_secure, attach-options.spec.ts
PORT=9011 ./test-worker/run.sh                                 # second cupola_test, multi-catalog.spec.ts
CUPOLA_TEST_MULTI_CATALOG=1 PORT=9012 ./test-worker/run.sh     # cupola_test + cupola_edge + cupola_secure (catalog picker)
VGI_BEARER_TOKENS="t=alice" ./test-worker/run.sh               # behind auth (VGI_OAUTH_* / VGI_JWT_* for real OAuth)
./test-worker/run-oauth.sh                                     # :9013 behind fake_idp.py (:9019): token expiry, refresh, popup re-auth; auth.whoami()
./test-worker/run-entra.sh                                     # :9015 behind real Entra (Query.Farm test app; dev server must be :4391)
bun run dev   # then http://localhost:4321/?service=http://localhost:9009
```

## Extension and worker versions
- `SHELL_EXTENSIONS` (`duckdb-engine.ts`) emits unpinned `INSTALL vgi FROM community`; `stress_worker.py` pins matching vgi-python/vgi-rpc. They move together.
- `?vgi_version=<build>` pins per tab; `./test-worker/run.sh --latest` resolves the newest worker ignoring pins.
- vgi-rpc floor, each failing elsewhere than it looks:
  - < 0.45.0: no `VGI-Accept-Max-Response-Bytes-Support` → sidebar works, SQL shell dead (`IO Error: VGI HTTP server does not advertise …` in console).
  - < 0.46.0: no `vgi_rpc.Reflection.v1` (old `__describe__`) → catalog fetch 404s, nothing renders.

## Portability
- Specs discover the attached catalog (`information_schema.schemata` minus `memory`/`system`/`temp`) and `test.skip` when none; never hardcode a dataset.

| var | purpose |
|-----|---------|
| `VGI_SERVICE_URL` | VGI server (default `http://localhost:9009`) |
| `VGI_OPTIONS_SERVICE_URL` | attach-options worker (default `http://localhost:9010`); `attach-options.spec.ts` skips option tests without it |
| `VGI_SECOND_SERVICE_URL` | second plain worker (default `http://localhost:9011`), also `cupola_test` (alias de-dup in `multi-catalog.spec.ts`); it and `workspaces.spec.ts` skip if either worker is down |
| `VGI_DEAD_SERVICE_URL` | nothing listening, for failing-catalog tests (default `http://127.0.0.1:9199`) |
| `CUPOLA_APP_ORIGIN` | app origin; **set when 4321 is taken** (`astro dev` silently falls through to 4322/4323) |
| `CUPOLA_BASE` | base path, e.g. `/v0.4.109/` |

## Evidence specs
- Run against `https://vgi-cupola-test.rusty-bb6.workers.dev` (repo `~/Development/vgi-cupola-test`). `main` = Open-Meteo functions replaying recorded responses (dates shifted to today); `demo` = Evidence demo tables.
- `evidencePath()` (`tests/helpers.ts`) adds `service=` (`CUPOLA_EVIDENCE_SERVICE` overrides). `isWeatherService()` (`src/lib/evidence/weather.ts`) also matches the real Open-Meteo Worker.
- `No recorded response for …` → record it in that repo (`make record`) and redeploy.
- Dev pre-bundles `lucide-svelte`, `date-fns`, `chroma-js` (`optimizeDeps.include`; `@evidence/core` is excluded so Vite never discovers them). `bits-ui`, `runed` and the toolbelt family stay unbundled on purpose (`evidence-svelte-exports` keeps per-importer copies).

## Playwright config
- **Bundled Chromium, not branded Chrome** (`PW_CHANNEL=chrome` opts in): Chrome's updater stalls browser close.
- **Base extensions only** (`tests/extensions.ts`, `restrictShellExtensions`): `storageState` seeds `cupola.test.extensions` (icu, json, httpfs, vgi); dev server honours it, published builds ignore it. Opt in per spec: `test.use({ storageState: withExtensions("autocomplete") })`. Don't rely on autoload (hangs the engine; still on 1.5.5-rc8); explicit `INSTALL` + `LOAD` after boot is safe.
- **Workers default 4** (`PLAYWRIGHT_WORKERS` overrides). Unbounded workers caused mass "DuckDB bridge never became ready". Ruled out: dev server wasm serving, per-browser DuckDB threads. More worker threads made it worse (one GIL-bound process).
- Budgets: 60s per test; `.test_formats` waits 150s.
- **Restart `bun run dev` after a version bump**: `base` is fixed at startup, `helpers.ts` reads it per run → 404s, misleading "tree never became visible" in `gotoApp`.

## `.test_formats`
- Terminal formatter vs DuckDB CLI reference; tolerates `≥106`/`≤4`. Permitted failures (rendering only): `timestamp_tz[0/1]`, `timestamptz_array[1]` (ICU DST offset), `varchar[1]` (tab collapsed). Don't widen the tolerance to absorb a regression.
