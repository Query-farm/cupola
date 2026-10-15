---
paths:
  - "src/lib/service.ts"
  - "src/lib/vgi-catalog-types.ts"
  - "src/lib/node-stubs.ts"
  - "src/lib/arrow-to-duckdb.ts"
  - "src/lib/function-info.ts"
  - "astro.config.mjs"
  - "tsconfig.json"
  - "package.json"
  - "bun.lock"
  - "test-worker/**"
---

# VGI client, wire model and Apache Arrow

## Browser-only imports
- Use `vgi/client` (browser-safe) and `@query-farm/vgi-rpc/connect` (aliased in `astro.config.mjs` to the source client module); the main packages contain Node code.
- `src/lib/node-stubs.ts` (aliased in `astro.config.mjs`) gives Arrow's Node I/O minimal class shells so `class X extends Readable` doesn't throw.

## Schema path vs name (`src/lib/vgi-catalog-types.ts`)
- Wire (VGI ≥ 0.29): `SchemaInfo.path: string[]`, `schema_path: string[]`. Cupola and DuckDB use a single schema name (hash route, generated SQL, AI tools, extension mapping).
- Flattened once in `fetchCatalog` with `join(".")`. Import types from `./vgi-catalog-types` (or `./service`), never `vgi/client`; only `service.ts` and the boundary module see the wire shape. RPC calls still take the real `path`.

## One Apache Arrow
- Import Arrow **only** from `@query-farm/apache-arrow`: never bare `apache-arrow`, never a CDN. Multiple builds give nominally distinct types and IPC bugs.
- Requires **all three**: pinned `@query-farm/apache-arrow` dependency, `vite.resolve.dedupe` in `astro.config.mjs`, matching `paths` in `tsconfig.json` (keep the last two in sync).
- Unit tests must import the same package, or they build tables the code can't decode.
- `@haybarn/haybarn-wasm`'s own `apache-arrow@17` (`^17.0.0` in `bun.lock`) is fine: raw IPC bytes only. It is the source of the transitive hoist, not Perspective.

## Arrow → DuckDB types
- `arrow-to-duckdb.ts` maps Arrow (Utf8, Int64, Date32) to DuckDB names (VARCHAR, BIGINT, DATE); `ARROW:extension:name` `geoarrow.wkb` → `GEOMETRY`.

## Dependencies
- `vgi` (npm alias for `@query-farm/vgi`) and `@query-farm/vgi-rpc`: exact published releases.
- They move together with `stress_worker.py`'s pins and the unpinned `INSTALL vgi FROM community` extension (see schema path above and the vgi-rpc floor in `testing.md`).
- `~/Development/perspective` (branch `duckdb-type-support-v5.5`) is needed only to rebuild Perspective (`./build-perspective.sh`), not for `bun run build`.
