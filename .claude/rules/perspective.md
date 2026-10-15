---
paths:
  - "public/perspective/**"
  - "build-perspective.sh"
  - "src/lib/perspective-*.ts"
  - "src/lib/pivot-source.ts"
  - "src/components/DuckDBShell.tsx"
  - "src/components/AppTabBar.tsx"
  - "tests/perspective*.spec.ts"
  - "tests/evidence-pivot-release.spec.ts"
---

# Perspective (vendored fork, pivots)

## The fork
- No `@perspective-dev/*` npm dependency. `public/perspective/` is a local build of `~/Development/perspective` branch `duckdb-type-support-v5.5` (upstream `v5.5.1` + two commits: DuckDB Arrow coercion for hugeint/uuid/timetz/interval/bignum/bit + all dictionary key widths; `Int64` preservation). Also needed: `view_collapse`/`view_expand` handler methods (`ViewTraversal` in `perspective-duckdb-handler.ts`).
- Old branch `duckdb-type-support-v5` (on `v5.1.0`) is kept. To upgrade: cherry-pick the two commits onto the new tag, re-run `./build-perspective.sh`.

## Traps (each reports the wrong cause)
- **Don't flatten the staging layout** (`<pkg>/dist/cdn` + `<pkg>/dist/wasm`). Bundles find siblings by relative URL; flat → `WebAssembly.compile(): BufferSource argument is empty` and server wasm requested from the origin root.
- **`Missing perspective-client.wasm` is a red herring**: the viewer's top-level `init_client` swallows a failed load and the element is never defined. Check the URL of `viewer/dist/wasm/perspective-viewer.wasm` first.
- **`.gitignore` needs `!public/perspective/**/dist/`**: the blanket `dist/` rule hides every vendored artifact; commits ship a broken app while local tests pass.
- **Use `viewer-charts`, not `viewer-d3fc`** (d3fc and openlayers deleted upstream). The d3fc name 404s and rejects `ensurePerspectiveLoaded()`, breaking both paths.
- **Source-map 404s**: the staging script deletes `.map` files *and* strips the trailing `sourceMappingURL` line. If the 404s reappear, the strip didn't run on a newly copied file. Harmless otherwise.

## Build prerequisites (encoded in `build-perspective.sh`)
- `rust/perspective-client/src/rust/proto.rs` is gitignored/generated; stale → ~56 "struct X has no field named Y". Regenerate with `PROTOC=… --features generate-proto`.
- `PACKAGE` must include `metadata` (ts-rs bindings), else `tsc`: `Cannot find module '.../ts-rs/ColumnType.d.ts'`.
- `PSP_WASM64=1` also builds `perspective-server.memory64.wasm` (16GB heap vs 4GB). Never `only` (drops the wasm32 fallback). `perspective.cdn.ts` prefers wasm64 when `host_supports_memory64()`. A missing memory64 file only warns (`select_server_wasm` falls back). wasm32 at its ceiling fails as `Abort(): malloc of size N failed`.

## Two code paths, one container
- **Static snapshot**: `ui.showPerspective(arrowBuffer)` (`perspectiveWorker.table()`), from shell `.perspective` and editor Pivot → Snapshot. No grouping.
- **Virtual server** (`VgiDuckDBHandler`, pivots compiled to SQL): a table's Pivot button, editor Run in Perspective, Pivot → Live view / Table (`ui.showPerspectiveQuery`, `src/lib/pivot-source.ts`, over a TEMP view/table).
- Specs: `perspective.spec.ts`, `perspective-virtual-server.spec.ts`, `perspective-query-pivot.spec.ts`.
- Virtual mounts are queued (`mountVirtualPerspective`). The sidebar auto-load mounts only a selection different from `handledSelectionRef`. Snapshot/query pivots mark the selection handled, or a second mount deletes the viewer mid-`restore()` ("null pointer passed to rust"). A cancelled unfinished mount clears the mark. A snapshot clears `perspectiveTableRef` so its layout isn't saved as the table's.

## Perspective tab
- Exists only while it holds something (`openTabs`/`onCloseTab` in `AppTabBar`, `perspectiveOpen` in `CatalogApp`). Every way in switches to it. `ui.pivotSelectedTable` clears the handled mark first.
- Close runs `ui.closePerspective` → `unmountPerspective`: saves a virtual layout under its table, frees snapshot Table + viewer (queued behind in-flight mount), drops the query pivot's scratch object, returns to the previous tab.

## Serve modes (`PerspectiveServeMode`, chosen by probing for `rowid`)
- One handler + client per mode (Perspective reads features per client).
- **materialized** (Table-mode pivots, `memory` tables): layouts are `TEMP TABLE`s, `rowid` orders.
- **live** (VGI tables, live-view pivots): layouts are `TEMP VIEW`s. `row_id_expr: "CAST(NULL AS INTEGER)"` (bare `NULL` is refused), `unordered: true`.
- Layouts that split or aggregate are always `TEMP TABLE` (`PIVOT ON` can't live in a view; `layoutIsFlat`).
- Uses 5.5 builder options `create_entity`, `drop_entity`, `row_id_expr`. Column names pass through unchanged (no `_`→`-` rename).
- Scratch objects live in `temp.main` (a view in `memory` can't see a TEMP source).
- Console log per query: `[perspective sql] <step> · <ms> · <size or error>`.

## Static snapshot lifetime (`loadPerspective`/`releasePerspective` in `DuckDBShell.tsx`)
- `viewer.load` doesn't own the Table. `table.delete()` while a View exists aborts ("Cannot delete table with views") and consumes the handle, so it can't be retried and the table leaks.
- Fix: `viewer.eject()` first, then `delete({ lazy: true })`. Tracked in a `WeakMap` per host container. Loads per container are serialized; a superseded load resolves `false`. Hosts call `releasePerspective` on unmount.
- Guard: `tests/evidence-pivot-release.spec.ts` (exactly one `cupola-static-*` table survives each refresh).
