---
paths:
  - "src/components/Sidebar.tsx"
  - "src/components/editor/**"
  - "src/components/inspector/**"
  - "src/components/content/**"
  - "src/lib/editor/**"
  - "src/lib/callable.ts"
  - "src/lib/builtin-functions.ts"
  - "src/lib/service.ts"
  - "tests/editor-*.spec.ts"
  - "tests/sql-editor.spec.ts"
  - "tests/sidebar*.spec.ts"
  - "tests/query-history.spec.ts"
  - "tests/data-grid-columns.spec.ts"
---

# Query editor, sidebar, history and data grid

## Sidebar while the editor is open (`Sidebar.tsx` `insertTarget`, `RightDock.tsx`, `components/inspector/`)
- A click opens the object in the editor's **Inspector**; the selection URL is replaced, not pushed.
- ⌘/Ctrl-click inserts instead (`onSelectChange` gets the event; `preventDefault()` skips selection).
- Hover preview: one lazy card per tree (`renderHover`), outside React context.
- **One `Callable` model** (`callable.ts`) for VGI functions, DuckDB functions, macros. `macroArgs` falls back to parameter names (plain macros have no args in `vgi_function_arguments()`). One row per overload: lookups return arrays; tree shows one row per name.
- **Inserted calls are fully qualified** (`call-snippet.ts`; a `USE` in the shared session changes short names). Required positional args → numbered tab stops; named/variadic omitted.
- **Inspector and Ask AI share `RightDock`**; both bodies stay mounted (AI per-tab conversations are component state). Keys: `vgi-editor-dock-open/-tab` (fallback read of `vgi-editor-ai-open`), width `vgi-editor-ai-width`.

## In-editor help (`cm-catalog-help.ts`)
- `call-context.ts` skips strings, quoted identifiers, comments; `IN (`/`OVER (` are not calls.
- Catalog read via getter (`buildCatalogIndex`, cached per inventory snapshot): editor is created once.
- Escape binding is `Prec.highest`, ahead of `autocompletion()` (which claims Escape whenever a request is pending); defers only to an open list (`currentCompletions`). Help hides when unfocused.

## DuckDB built-ins (`builtin-functions.ts`)
- From `duckdb_functions()` in `system`, read via `fetchAttachedCatalog`'s `functionsOnly` once the engine is ready; not in the sidebar inventory. Re-read after inventory changes (`LOAD` adds functions). `refreshCatalogHelp` redraws help typed before they arrived.
- Bare-name ranking: default catalog (`CatalogData.isDefault`), then built-ins, then other catalogs (DuckDB's search order). Inserted unqualified.
- Table-function `parameters` mixes positional (`col0`, `col1`, …) with named options in no stable order; `parameterArgs` splits them (else `read_csv` inserts 46 args). `varargs` names the variadic tail's type. `signatureParts` folds >6 named options into a count, keeping the one being typed.

## Query history (`src/lib/editor/query-history.ts`, `HistoryPanel.tsx`)
- All surfaces record via `ui.addQueryHistoryEntry` (`recordQuery` in `shell-bridge.ts`) with a `source`. Key `cupola.query-history.v1::<workspace id>` (service URL outside a workspace); newest first, cap 300, halved until it fits when storage is full.
- An entry opens in a new editor tab (Run executes it there). Immediate identical re-run folds into a run count. Stored `vgi-active-tab` of `queries` restores to the editor.
- **This tab** view = revisions (`tab-revisions.ts`): whole-buffer snapshots on run and around Ask AI apply / Restore / Format. Separate from the shared 300-entry run log on purpose. Key `cupola.editor-revisions.v1::<workspace id>::<docId>` (fallback `<service>` key); cap 50; texts stored once by hash; deleted with the tab.
- **All** view = searchable log for the workspace; **All workspaces** checkbox uses `loadAllQueryHistories` (Clear hidden there).
- `setDoc` dispatches with `isolateHistory` so restore/format/AI apply is its own undo step.

## Column stats
- `fetchColumnStats()` (`service.ts`) queries `vgi_table_statistics()`; awaits `bridge.attached` internally. `TableDetail` calls it only for `vgi` catalogs (`databaseType`). `ColumnProfile` does on-demand distribution analysis.

## Grid column sizing (`DataGrid.tsx`)
- Measured once per result set at `width: max-content` (not `w-full`), frozen into `<colgroup>`.
- Clamp `[48px, min(400px, 60% of panel)]`; leftover goes to a trailing spacer column (the only auto-width `<col>`).
- Resize handle: drag sets width, double-click autofits via canvas `measureText` (frozen layout clips the DOM). Hand-set widths keyed by column name, survive sort/pager re-measure, cleared when the column set changes.
- Sortable headers always reserve the chevron's 16px.
