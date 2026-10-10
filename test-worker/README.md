# Cupola test worker

A VGI worker that serves the `cupola_test` catalog: synthetic datasets sized and
shaped to test Cupola itself — report blocks, grids, charts, Perspective, the AI
report builder. Everything is generated from a seed at scan time, so there are no
data files, no network calls, and a given row is identical on every machine.

**Development only. It is never published.** `publish.sh` and the Docker image
ship `dist/` alone (`.dockerignore` whitelists `dist` and `Caddyfile`), Astro
builds only `src/` and `public/`, and the package is `private`. Keep it out of
`public/`.

## Run

```bash
./run.sh                    # http://127.0.0.1:9009, no auth, CORS open
PORT=9010 ./run.sh          # another port
HTTP_THREADS=16 ./run.sh    # larger request pool (default 8)
```

Then open `http://localhost:4321/?service=http://localhost:9009`. Port 9009 is the
Playwright suite's default `VGI_SERVICE_URL`, so `bun run test:e2e` works against
it with no configuration. Needs only [`uv`](https://docs.astral.sh/uv/);
dependencies are declared inline in `stress_worker.py`.

### Attach-options variant

`CUPOLA_TEST_ATTACH_OPTIONS=1 PORT=9010 ./run.sh` serves the same data as
`cupola_secure`, a catalog that declares attach options: `api_key` (required,
secret), `region` (VARCHAR) and `max_rows` (INTEGER). It refuses an ATTACH
without `api_key`, which is what `tests/attach-options.spec.ts` needs (it reads
the variant's URL from `VGI_OPTIONS_SERVICE_URL`, default
`http://localhost:9010`). Needs vgi-python 0.38+, the first release with the
`secret` flag.

### Two catalogs

`tests/multi-catalog.spec.ts` needs a second worker beside the first:
`PORT=9011 ./run.sh` (the spec reads it from `VGI_SECOND_SERVICE_URL`). Both
serve `cupola_test`, which is the point: the second is attached as
`cupola_test_2`, so the same pair covers several catalogs, a cross-catalog join
and alias de-duplication.

### Several catalogs from one URL

`CUPOLA_TEST_MULTI_CATALOG=1 PORT=9012 ./run.sh` serves three catalogs from one
worker (a vgi-python `MetaWorker`), for the catalog checkbox list on the welcome
page and in "Attach a catalog…":

| catalog | schemas | options |
|---------|---------|---------|
| `cupola_test` | small, large, edge | none. Listed first, so `?service=` still opens it |
| `cupola_edge` | edge | none |
| `cupola_secure` | small, edge | `api_key` (required, secret), `region`, `max_rows` |

It can't be combined with `CUPOLA_TEST_ATTACH_OPTIONS`, which would serve a
second `cupola_secure`. It serves HTTP only.

### Behind auth

Both modes read the same auth environment as `Worker.main`, so either can be
protected without editing the worker:

- `VGI_BEARER_TOKENS="token=principal"`: static bearer tokens. Anonymous RPC
  calls (including `catalogs_info`) get a 401, while `/health` stays open. The
  quickest way to check Cupola's "Sign in to list catalogs" prompt appears.
- `VGI_OAUTH_*` (`VGI_OAUTH_AUTH_SERVERS`, `VGI_OAUTH_CLIENT_ID`,
  `VGI_OAUTH_CLIENT_SECRET`, `VGI_OAUTH_SCOPES`, `VGI_OAUTH_USE_ID_TOKEN`, …)
  with `VGI_JWT_ISSUER` / `VGI_JWT_AUDIENCE`: OAuth resource metadata at
  `/.well-known/oauth-protected-resource` plus JWT validation, which is what
  Cupola's PKCE sign-in follows. See `vgi/serve.py` in vgi-python for the full
  list.

From a DuckDB-compatible CLI, without HTTP:

```sql
ATTACH 'cupola_test' (TYPE vgi, LOCATION 'uv run stress_worker.py');
```

One request holds one server thread for the length of its scan, so the pool has
to be at least as large as the number of browsers you point at it (default 32,
override with `HTTP_THREADS`). Raising it does not buy more parallelism — the
worker is a single GIL-bound process — so the suite bounds its own worker count
instead (see `playwright.config.ts`).

### Version pinning

The worker is pinned to the vgi-python release that speaks the same wire
protocol as Cupola's pinned VGI extension (`VGI_EXTENSION_VERSION` in
`src/lib/duckdb-engine.ts`) — currently protocol 1.3.0, vgi-python 0.28.x. A newer
worker rejects every request from that extension with `ProtocolVersionError:
client is too old`. When the extension pin moves, move the two version ranges at
the top of `stress_worker.py` with it.

`./run.sh --latest` ignores the pins and runs the newest vgi-python; pair it with
`?vgi_version=latest` in the app URL.

## Datasets

### `small` — reference tables a report can render in full

| table | rows | use |
|-------|-----:|-----|
| `regions` | 8 | region, manager, map center |
| `products` | 200 | 12 categories, `DECIMAL` list price |
| `stores` | 250 | lat/lon plus a `GEOMETRY` point — map blocks |
| `monthly_targets` | 288 | 36 months × 8 regions, target vs actual — bullet, slopegraph, sparkline, KPI |
| `orders_1k` | 1,000 | the large orders table, small enough to eyeball |

### `large` — volume

| table | rows | what it stresses |
|-------|-----:|------------------|
| `orders_100k` / `orders_400k` / `orders_2m` | as named | 18 mixed-type columns. 400k is the size that killed the tab in a report Perspective block |
| `wide_400k` | 400,000 | 60 columns; `dimension_00`–`08` have 2–512 distinct values |
| `events_1m` | 1,000,000 | high-cardinality strings, a ~190-char JSON string, `LIST` and `STRUCT` columns |
| `parcels_400k` | 400,000 | a WKB polygon `GEOMETRY` per row |
| `daily_revenue` (view) | ~8,800 | a heavy source behind a small result |

Orders join to `small.products` (`product_id`), `small.stores` (`store_id`) and
`small.regions` (`region`), and carry a seasonal curve with a holiday peak so trend
charts have shape.

For any other size, call the generators directly:

```sql
SELECT * FROM cupola_test.large.generate_orders(750000);
SELECT * FROM cupola_test.large.generate_wide(50000);
SELECT * FROM cupola_test.large.generate_events(10000);
SELECT * FROM cupola_test.large.generate_parcels(1000000);
```

### `edge` — types, shapes, failures

| object | purpose |
|--------|---------|
| `all_types` | 1,000 rows, one column per Arrow type: every integer width, `UBIGINT` max, `BIGINT` past 2^53, `DECIMAL(38,0)`, `NaN`/`Infinity`, pre-epoch dates, `TIME`, `TIMESTAMP`/`TIMESTAMPTZ`, `INTERVAL`, `BLOB`, `LIST`, `STRUCT`, `MAP`, awkward Unicode. Every 7th value is `NULL` |
| `empty` | a schema and zero rows |
| `all_nulls` | 100 rows, every column but `id` entirely `NULL` |
| `"awkward names"` | identifiers with spaces, quotes, dots, brackets, keywords, non-ASCII |
| `"hidden$table"` | hidden by the `hideDollarTables` setting |
| `slow_rows(rows, delay_ms)` | sleeps `delay_ms` before each 1,000-row chunk — loading states, cancellation, overlapping refreshes |
| `fail_after(rows)` | streams `rows` good rows, then errors mid-scan |
| `rate_limited()` | always fails with an HTTP 429 message, to exercise the report runner's rate-limit handling offline |

Fault injection is **functions only**. Every table in the catalog is safe to scan,
so anything that walks the catalog — a spec picking "any table", column
statistics, the data preview — never trips a deliberate failure. Use them as a
report dataset's SQL: `SELECT * FROM cupola_test.edge.slow_rows(20000, 1000)`.

## Adding a dataset

Subclass `ChunkedGenerator` (streamed, row-count argument) or `StaticTable` (one
small batch), give it a `FIXED_SCHEMA` and a `Meta.name`, and register it in a
schema's `functions` and — via `sized(...)` or `Table(...)` — its `tables`. Build
columns with numpy/pyarrow vector operations, not Python loops: `orders_2m` is 40
chunks that scan in well under a second, and a per-row loop turns that into minutes. Seed randomness
from the `rng` handed to `chunk()`, never from global state, or scans stop being
reproducible.
