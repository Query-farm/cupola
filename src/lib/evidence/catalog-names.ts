/** Evidence's table catalog for a Cupola session, named the way DuckDB names tables.
 *
 * Evidence's built-in DuckDB loader (warehouse mode `motherduck`) keys every table
 * `schema.table`. Cupola attaches several databases — each VGI catalog, `memory`,
 * `temp` — so two catalogs with a `main.orders` overwrote each other's columns, and a
 * report's `demo.daily_orders` (catalog.table) matched nothing at all. Here every
 * table is keyed by its full `catalog.schema.table`, and the shorter names resolve
 * exactly as DuckDB resolves them, so the metadata never names a table DuckDB would
 * not reach with the same reference. */

export type ColumnRow = {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  /** 1 for a view. Query rows cannot carry booleans. */
  is_view?: number;
};

export interface CatalogTable { name: string; view: boolean; columns: { name: string; type: string }[] }

/** A catalog and schema DuckDB searches for unqualified names, in search order. */
export interface SearchEntry { catalog: string; schema: string }

/** Identifiers are case-insensitive in DuckDB. */
const key = (...parts: string[]) => parts.join('.').toLowerCase();

export function indexCatalog(rows: readonly ColumnRow[], search: readonly SearchEntry[]) {
  const tables = new Map<string, CatalogTable>();
  for (const row of rows) {
    const name = `${row.table_catalog}.${row.table_schema}.${row.table_name}`;
    let table = tables.get(name);
    if (!table) tables.set(name, table = { name, view: Boolean(row.is_view), columns: [] });
    table.columns.push({ name: row.column_name, type: row.data_type });
  }

  // First registration wins, so the order below is DuckDB's precedence.
  const aliases = new Map<string, string>();
  const alias = (short: string, full: string) => { if (!aliases.has(short)) aliases.set(short, full); };
  const searchCatalogs = [...new Set(search.map(entry => entry.catalog.toLowerCase()))];
  const rowsOf = (predicate: (t: { catalog: string; schema: string; table: string }) => boolean) =>
    [...tables.keys()].map(full => { const [catalog, schema, ...rest] = full.split('.'); return { full, catalog, schema, table: rest.join('.') }; }).filter(predicate);

  // Bare `table`: the search path's catalog/schema pairs, in order (temp before the default).
  for (const entry of search) {
    for (const t of rowsOf(t => t.catalog.toLowerCase() === entry.catalog.toLowerCase() && t.schema.toLowerCase() === entry.schema.toLowerCase())) alias(key(t.table), t.full);
  }
  // `x.table`: DuckDB tries `x` as a schema in the searched catalogs first, then as a
  // catalog with its `main` schema.
  for (const catalog of searchCatalogs) {
    for (const t of rowsOf(t => t.catalog.toLowerCase() === catalog)) alias(key(t.schema, t.table), t.full);
  }
  for (const t of rowsOf(t => t.schema.toLowerCase() === 'main')) alias(key(t.catalog, t.table), t.full);
  // The full name, case-folded.
  for (const full of tables.keys()) alias(full.toLowerCase(), full);

  return { tables, aliases };
}
