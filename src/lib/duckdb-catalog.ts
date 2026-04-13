/**
 * Build a `CatalogData` for an already-attached DuckDB database by
 * introspecting the DuckDB metadata functions through the shell bridge.
 *
 * Used for catalogs the user ATTACH'd from the shell (TYPE vgi, LOCATION ...).
 * Unlike `fetchCatalog(url)` which opens its own HTTP+RPC connection to the
 * VGI server, this path reuses the DuckDB-WASM extension's authenticated
 * session — OAuth tokens never need to leave the extension.
 *
 * This is the cross-catalog generalization of `fetchMemoryTables` in
 * CatalogApp.tsx. It can target any attached database by `database_name`,
 * including `memory` (though the existing code still uses fetchMemoryTables
 * for that).
 */
import { esc, readRows } from "./duckdb-query";
import type { CatalogData, ResolvedSchema } from "./service";

/** Convert an Arrow Vector / JS iterable to a plain string[]. Handles both
 *  the `toArray()` path (apache-arrow list vectors) and the iterable path
 *  (apache-arrow returns iterables for some list element types). */
function toStringArray(v: any): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v.toArray === "function") return v.toArray().map((x: any) => String(x));
  if (typeof v[Symbol.iterator] === "function") {
    const out: string[] = [];
    for (const x of v) out.push(String(x));
    return out;
  }
  return [];
}

/** DuckDB function_type values that represent macros (as opposed to regular
 *  functions). Everything else lands in the functions list. */
const MACRO_TYPES = new Set(["macro", "table_macro"]);

/**
 * Fetch a full `CatalogData` for an attached DuckDB database by name.
 * Returns a minimal empty catalog (zero schemas) if the shell bridge isn't
 * available or any of the metadata queries fail.
 */
export async function fetchAttachedCatalog(databaseName: string): Promise<CatalogData> {
  const dbLit = `'${esc(databaseName)}'`;

  // Parallel metadata fetches — none depend on each other.
  const [schemaRows, tableRows, viewRows, columnRows, functionRows] = await Promise.all([
    readRows(
      `SELECT schema_name, comment FROM duckdb_schemas() WHERE database_name = ${dbLit} AND NOT internal ORDER BY schema_name`
    ),
    readRows(
      `SELECT schema_name, table_name, comment FROM duckdb_tables() WHERE database_name = ${dbLit} AND NOT temporary ORDER BY schema_name, table_name`
    ),
    readRows(
      `SELECT schema_name, view_name, comment, sql FROM duckdb_views() WHERE database_name = ${dbLit} AND NOT temporary ORDER BY schema_name, view_name`
    ),
    readRows(
      `SELECT schema_name, table_name, column_name, column_index, data_type, is_nullable, column_default, comment
       FROM duckdb_columns() WHERE database_name = ${dbLit} ORDER BY schema_name, table_name, column_index`
    ),
    // VGI-registered table functions are marked internal=1, so we cannot
    // filter on `NOT internal`. We include every function in the database
    // and rely on the sidebar's `hideTableBackingFunctions` setting to
    // dedupe same-named table + table function pairs.
    readRows(
      `SELECT schema_name, function_name, function_type, description, comment, parameters, parameter_types, return_type, macro_definition
       FROM duckdb_functions() WHERE database_name = ${dbLit} ORDER BY schema_name, function_name`
    ),
  ]);

  // Schema name → resolved slot. Seed with schemas from duckdb_schemas() so
  // empty schemas still show up.
  const schemaMap = new Map<string, ResolvedSchema>();
  const getSchema = (name: string, comment: string | null = null): ResolvedSchema => {
    let s = schemaMap.get(name);
    if (!s) {
      s = {
        info: { name, comment, tags: {} } as any,
        tables: [],
        views: [],
        functions: [],
        macros: [],
      };
      schemaMap.set(name, s);
    }
    return s;
  };

  for (const row of schemaRows ?? []) {
    const name = String(row.schema_name ?? "");
    if (!name) continue;
    const comment = row.comment == null ? null : String(row.comment);
    // Overwrite the default-created slot with the real comment
    getSchema(name, comment).info = { name, comment, tags: {} } as any;
  }

  // Group columns by schema.table into a map so we can attach them as
  // `_columnInfo` overrides on the corresponding table/view entries.
  type Col = { name: string; duckdbType: string; nullable: boolean; comment?: string; defaultValue?: string };
  const colsByTable = new Map<string, Col[]>();
  for (const row of columnRows ?? []) {
    const schema = String(row.schema_name ?? "");
    const table = String(row.table_name ?? "");
    const key = `${schema}.${table}`;
    let arr = colsByTable.get(key);
    if (!arr) {
      arr = [];
      colsByTable.set(key, arr);
    }
    const duckType = String(row.data_type ?? "");
    const isNullableRaw = row.is_nullable;
    const nullable =
      isNullableRaw === true ||
      isNullableRaw === 1 ||
      String(isNullableRaw).toLowerCase() === "yes" ||
      String(isNullableRaw) === "true";
    const col: Col = {
      name: String(row.column_name ?? ""),
      duckdbType: duckType,
      nullable,
    };
    if (row.comment != null && String(row.comment) !== "") col.comment = String(row.comment);
    if (row.column_default != null && String(row.column_default) !== "") col.defaultValue = String(row.column_default);
    arr.push(col);
  }

  const emptyColumns = new Uint8Array(0);
  const emptyFkBytes: Uint8Array[] = [];

  for (const row of tableRows ?? []) {
    const schemaName = String(row.schema_name ?? "");
    if (!schemaName) continue;
    const name = String(row.table_name ?? "");
    const comment = row.comment == null ? null : String(row.comment);
    const cols = colsByTable.get(`${schemaName}.${name}`) ?? [];
    const notNullConstraints: number[] = [];
    cols.forEach((c, idx) => { if (!c.nullable) notNullConstraints.push(idx); });

    // `columns` is normally a serialized Arrow schema. We leave it as an
    // empty Uint8Array and rely on the `_columnInfo` override path in
    // service.ts's getColumns() to surface real column metadata.
    const entry: any = {
      name,
      schemaName,
      comment,
      tags: {},
      columns: emptyColumns,
      notNullConstraints,
      uniqueConstraints: [],
      checkConstraints: [],
      primaryKeyConstraints: [],
      foreignKeyConstraints: emptyFkBytes,
      _columnInfo: cols.map((c) => ({
        name: c.name,
        arrowType: c.duckdbType,
        duckdbType: c.duckdbType,
        nullable: c.nullable,
        ...(c.comment ? { comment: c.comment } : {}),
        ...(c.defaultValue ? { defaultValue: c.defaultValue } : {}),
      })),
    };
    getSchema(schemaName).tables.push(entry);
  }

  for (const row of viewRows ?? []) {
    const schemaName = String(row.schema_name ?? "");
    if (!schemaName) continue;
    const name = String(row.view_name ?? "");
    const comment = row.comment == null ? null : String(row.comment);
    const definition = row.sql == null ? "" : String(row.sql);
    const cols = colsByTable.get(`${schemaName}.${name}`) ?? [];

    const entry: any = {
      name,
      schemaName,
      comment,
      tags: {},
      definition,
      columns: emptyColumns,
      notNullConstraints: [],
      uniqueConstraints: [],
      checkConstraints: [],
      primaryKeyConstraints: [],
      foreignKeyConstraints: emptyFkBytes,
      _columnInfo: cols.map((c) => ({
        name: c.name,
        arrowType: c.duckdbType,
        duckdbType: c.duckdbType,
        nullable: c.nullable,
        ...(c.comment ? { comment: c.comment } : {}),
      })),
    };
    getSchema(schemaName).views.push(entry);
  }

  for (const row of functionRows ?? []) {
    const schemaName = String(row.schema_name ?? "");
    if (!schemaName) continue;
    const name = String(row.function_name ?? "");
    const functionType = String(row.function_type ?? "");
    const description = row.description == null ? "" : String(row.description);
    const comment = row.comment == null ? null : String(row.comment);
    const parameters = toStringArray(row.parameters);
    const parameterTypes = toStringArray(row.parameter_types);
    const returnType = row.return_type == null ? "" : String(row.return_type);

    if (MACRO_TYPES.has(functionType)) {
      const macroType = functionType === "table_macro" ? "table" : "scalar";
      const definition = row.macro_definition == null ? "" : String(row.macro_definition);
      const entry: any = {
        name,
        schemaName,
        macroType,
        parameters,
        parameterDefaultValues: null,
        definition,
        comment,
        tags: {},
      };
      getSchema(schemaName).macros.push(entry);
    } else {
      const entry: any = {
        name,
        schemaName,
        functionType,
        functionArguments: emptyColumns,
        outputSchema: emptyColumns,
        stability: null,
        nullHandling: null,
        description,
        examples: [],
        categories: [],
        projectionPushdown: null,
        filterPushdown: null,
        orderPreservation: null,
        maxWorkers: null,
        orderDependent: "NOT_ORDER_DEPENDENT",
        distinctDependent: "NOT_DISTINCT_DEPENDENT",
        requiredSettings: [],
        requiredSecrets: [],
        comment,
        tags: {},
        // Overrides consumed by any future parameter-rendering UI that
        // prefers parsed info over the binary-serialized VGI form.
        _parameters: parameters,
        _parameterTypes: parameterTypes,
        _returnType: returnType,
      };
      getSchema(schemaName).functions.push(entry);
    }
  }

  // Sort schemas alphabetically — no "default schema" concept in the
  // DuckDB-introspection path, so pick the first schema as default if any.
  const schemas = Array.from(schemaMap.values()).sort((a, b) =>
    a.info.name.localeCompare(b.info.name)
  );
  const defaultSchema = schemas[0]?.info.name ?? null;

  return {
    catalogName: databaseName,
    catalogComment: null,
    catalogTags: {},
    defaultSchema,
    schemas,
  };
}
