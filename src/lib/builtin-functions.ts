/**
 * DuckDB's own functions (`sum`, `strftime`, `read_csv`, …) for the editor's
 * hover and signature help. They live in the `system` database, which the
 * catalog inventory leaves out (the sidebar shouldn't list thousands of
 * built-ins), so they are read here: once, lazily, and again after the
 * inventory changes, since a `LOAD` registers an extension's functions there.
 */
import type { CatalogData } from "./service";
import { fetchAttachedCatalog } from "./duckdb-catalog";
import { catalogInventory } from "./catalog-store";
import { engine } from "./shell-bridge";

// Callable names only: no operators (`+`, `~~`) and nothing internal (`__internal_…`).
// Pragmas are not called from SQL expressions.
const FILTER = `function_type IN ('scalar', 'aggregate', 'table', 'macro', 'table_macro')`
  + ` AND regexp_matches(function_name, '^[A-Za-z][A-Za-z0-9_]*$')`;

let cached: CatalogData | null = null;
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let stale = false;

let lastCatalogs = catalogInventory.getSnapshot().catalogs;
catalogInventory.subscribe(() => {
  const { catalogs } = catalogInventory.getSnapshot();
  if (catalogs !== lastCatalogs) { lastCatalogs = catalogs; stale = true; }
});

/** Read (or re-read) the built-ins. Safe to call often; one load at a time. */
export function loadBuiltinFunctions(): Promise<void> {
  if (loading) return loading;
  if (cached && !stale) return Promise.resolve();
  if (!engine.query) return Promise.resolve();
  stale = false;
  loading = fetchAttachedCatalog("system", "builtin", { functionsOnly: true, functionFilter: FILTER })
    .then((catalog) => {
      if (catalog.metadataError && cached) return;
      cached = catalog;
      for (const l of listeners) l();
    })
    .catch(() => {})
    .finally(() => { loading = null; });
  return loading;
}

/** Called after each successful (re)load. Returns an unsubscribe. */
export function onBuiltinFunctionsLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The built-ins as last read, starting a (re)load when there are none yet or
 *  they are stale. Null until the first load finishes. */
export function builtinFunctions(): CatalogData | null {
  if (!cached || stale) void loadBuiltinFunctions();
  return cached;
}
