import { Metadata, TableMetadata } from '@evidence/core/metadata';
import { getMotherduckToJsType } from '@evidence/core/connectors/motherduck/type-mapping';
import { readRowsOrThrow } from '../duckdb-query';
import { indexCatalog, type ColumnRow } from './catalog-names';

/** Evidence metadata for every database attached to the session, keyed by
 * `catalog.schema.table` and resolved like DuckDB (see `catalog-names.ts`). Replaces
 * the built-in `motherduck` loader, which keyed tables `schema.table` and so mixed up
 * same-named tables across Cupola's attached catalogs. */
export class CupolaMetadata extends Metadata {
  #aliases = new Map<string, string>();
  #loading = $state(true);
  #loadFailed = $state(false);
  #generation = 0;

  override get loading() { return this.#loading; }
  override get loadFailed() { return this.#loadFailed; }

  override getTable(name: string) {
    return super.getTable(this.#aliases.get(name.toLowerCase()) ?? name);
  }

  override async load(): Promise<void> {
    const generation = ++this.#generation;
    this.#loading = true;
    this.#loadFailed = false;
    try {
      // Straight to the engine, not the report's query service: the catalog belongs to
      // the session, so stopping or re-running a report must not cancel it, and its
      // queries are not the report's (they used to surface as report problems).
      const [columns, search] = await Promise.all([
        readRowsOrThrow(`SELECT c.table_catalog, c.table_schema, c.table_name, c.column_name, c.data_type,
       CAST(coalesce(t.table_type = 'VIEW', false) AS INTEGER) AS is_view
FROM information_schema.columns c
LEFT JOIN information_schema.tables t USING (table_catalog, table_schema, table_name)
WHERE c.table_catalog <> 'system' AND c.table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY c.table_catalog, c.table_schema, c.table_name, c.ordinal_position`) as Promise<ColumnRow[]>,
        readRowsOrThrow(`SELECT current_database() AS catalog, current_schema() AS schema`) as Promise<{ catalog: string; schema: string }[]>,
      ]);
      if (generation !== this.#generation) return;
      const current = search[0];
      // DuckDB searches temp before the default database for unqualified names.
      const { tables, aliases } = indexCatalog(columns, [{ catalog: 'temp', schema: 'main' }, ...(current ? [current] : [])]);
      for (const table of this.tables) this.removeTableMetadata(table.name);
      for (const table of tables.values()) {
        this.addTableMetadata(new TableMetadata({
          name: table.name,
          tableType: table.view ? 'model' : 'table',
          columns: Object.fromEntries(table.columns.map(column => [column.name, { name: column.name, type: column.type, jsType: getMotherduckToJsType(column.type) }])),
        }));
      }
      this.#aliases = aliases;
    } catch {
      if (generation === this.#generation) this.#loadFailed = true;
    } finally {
      if (generation === this.#generation) this.#loading = false;
    }
  }
}
