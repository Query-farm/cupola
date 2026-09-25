import { CatalogInventory, changesCatalog } from './catalog-inventory';
import { fetchAttachedCatalog } from './duckdb-catalog';
import { readRowsOrThrow } from './duckdb-query';
import { ui } from './shell-bridge';
import type { CatalogData } from './service';

export const catalogInventory = new CatalogInventory({
  list: async () => (await readRowsOrThrow('SELECT database_name, database_oid, type FROM duckdb_databases()'))
    .map(row => ({ name: String(row.database_name), id: String(row.database_oid), type: String(row.type) })),
  load: db => fetchAttachedCatalog(db.name, db.type),
});

// Compatibility for imperative shell helpers. These are projections of the
// inventory, never separately fetched catalogs or state owned by a component.
catalogInventory.subscribe(() => {
  const { catalogs } = catalogInventory.getSnapshot();
  ui.memoryCatalog = catalogs.find(c => c.catalogName === 'memory') ?? null;
  ui.attachedCatalogs = catalogs.filter(c => !c.primary && c.catalogName !== 'memory');
});

export async function sessionCatalogs(fallback: readonly CatalogData[] = []): Promise<readonly CatalogData[]> {
  const state = catalogInventory.getSnapshot();
  return state.ready || state.catalogs.length ? catalogInventory.current() : fallback;
}

const CATALOG_TOOLS = new Set(['list_catalogs', 'list_tables', 'list_categories', 'describe_table', 'describe_function', 'compile_semantic_query', 'query_semantic_model']);

/** A metadata outage must not block SQL inspection, report editing, or reading
 * already cached results. Only discovery/semantic tools need a fresh inventory. */
export async function catalogsForTool(name: string, fallback: readonly CatalogData[] = []): Promise<readonly CatalogData[]> {
  return CATALOG_TOOLS.has(name) ? sessionCatalogs(fallback) : catalogInventory.getSnapshot().catalogs;
}

/** This runs outside the connection queue: metadata queries must never wait
 * for a queue item which itself is waiting for metadata. */
export async function observeCatalogQuery<T>(sql: string, query: () => Promise<T>): Promise<T> {
  try { return await query(); }
  finally { if (changesCatalog(sql)) catalogInventory.invalidate(); }
}
