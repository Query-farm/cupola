/**
 * VGI service wrapper — connects to a VGI HTTP server and fetches catalog metadata.
 */

// Import the client-only entry point to avoid bundling Node.js server code.
// astro.config.mjs resolves this to the browser artifact from the npm package.
import { httpConnect } from "@query-farm/vgi-rpc/connect";
import { VgiClient, Arguments, deserializeSchema, deserializeBatch, iterRows } from "vgi/client";
// The catalog types are Cupola's flat ones, not the wire types: a VGI schema
// is a path now, and it is flattened to a name here at the boundary. See
// ./vgi-catalog-types.
import type {
  SchemaInfo,
  TableInfo,
  ViewInfo,
  FunctionInfo,
  MacroInfo,
} from "./vgi-catalog-types";
import {
  flattenSchemaInfo,
  flattenTableInfo,
  flattenViewInfo,
  flattenFunctionInfo,
  flattenMacroInfo,
} from "./vgi-catalog-types";
import { getAuthTokenForService } from "./auth";
import { arrowFieldToDuckDB } from "./arrow-to-duckdb";
import { engine } from "./shell-bridge";
import { readRows, esc } from "./duckdb-query";
import { decodeOptionSpecs } from "./attach/specs";
import type { OptionSpecInfo } from "./attach/options";
import { isRecoverableAuthError } from "./auth-errors";
import type { ConnectionTest } from "./workspace/manager";
import { connectionErrorMessage } from "./connection-errors";

/** Column info extracted from a TableInfo's serialized Arrow schema. */
export interface ColumnInfo {
  name: string;
  /** Raw Arrow type string (e.g., "Utf8", "Int64", "Date32<DAY>"). */
  arrowType: string;
  /** DuckDB type string (e.g., "VARCHAR", "BIGINT", "DATE"). */
  duckdbType: string;
  nullable: boolean;
  comment?: string;
  defaultValue?: string;
  /** DuckDB 2.0 native column tags; absent on DuckDB 1.5. */
  tags?: Record<string, string>;
}

/** Parsed foreign key constraint. */
export interface ForeignKeyInfo {
  columns: string[];
  referencedTable: string;
  referencedSchema: string;
  referencedColumns: string[];
  /** Catalog-qualified targets are possible for attached DuckDB databases. */
  referencedCatalog?: string;
  /** Stable database constraint name, when the catalog exposes one. */
  constraintName?: string;
}

/** Fully resolved schema with its tables, views, and functions. */
export interface ResolvedSchema {
  info: SchemaInfo;
  tables: TableInfo[];
  views: ViewInfo[];
  functions: FunctionInfo[];
  macros: MacroInfo[];
}

/** Full catalog data ready for rendering. */
export interface CatalogData {
  /** The DuckDB alias: what SQL names this catalog by. */
  catalogName: string;
  databaseType?: string;
  /** The workspace's default catalog: the one `USE` points at. */
  isDefault?: boolean;
  /** Connection context, for catalogs the app attached itself
   *  (catalog-inventory.ts `CatalogConnection`). */
  sourceUrl?: string;
  /** The catalog's name on its server, when it differs from the alias. */
  serverCatalogName?: string;
  /** Non-secret attach options (DuckDB text). */
  attachOptions?: Record<string, string>;
  attachSpecs?: OptionSpecInfo[];
  /** Options set with a secret value, by name only. */
  secretOptionNames?: string[];
  /** Metadata may be partial; the attachment itself is still valid. */
  metadataError?: string;
  catalogComment: string | null;
  catalogTags: Record<string, string>;
  defaultSchema: string | null;
  schemas: ResolvedSchema[];
}

interface TableWithMetadataOverrides extends TableInfo {
  _columnInfo?: ColumnInfo[];
  _foreignKeys?: ForeignKeyInfo[];
}

// URL-param accessors moved to lib/url-params.ts. Re-exported here so existing
// import sites keep working without an immediate sweep.
export { getServiceUrl, hasExplicitService, getAttachOptionsFromUrl } from "./url-params";

// Cupola's flat catalog types, re-exported for a stable import surface: a
// component wanting a TableInfo should get the one with `schema_name` on it,
// without having to know that the wire type spells it `schema_path`.
export type {
  SchemaInfo,
  TableInfo,
  ViewInfo,
  FunctionInfo,
  MacroInfo,
} from "./vgi-catalog-types";

/** Extract column info from a TableInfo's serialized Arrow schema bytes.
 *  Also supports a pre-built _columnInfo override (used for in-memory tables). */
export function getColumns(table: TableInfo): ColumnInfo[] {
  // Check for pre-built column info (e.g., from DuckDB memory tables)
  const override = (table as TableWithMetadataOverrides)._columnInfo;
  if (Array.isArray(override)) return override;

  try {
    const schema = deserializeSchema(table.columns);
    return schema.fields.map((f) => ({
      name: f.name,
      arrowType: f.type.toString(),
      duckdbType: arrowFieldToDuckDB(f),
      nullable: f.nullable,
      comment: f.metadata?.get("comment") ?? undefined,
      defaultValue: f.metadata?.get("default") ?? undefined,
    }));
  } catch {
    return [];
  }
}

// Function metadata parsing/formatting lives in ./function-info (kept free of RPC
// imports so it stays unit-testable). Re-exported here for a stable import surface.
export type { FunctionArg, FunctionReturn } from "./function-info";
export {
  isTableFunction,
  getFunctionArgs,
  getFunctionReturn,
  formatFunctionSignature,
} from "./function-info";

/** Parse foreign key constraints from a TableInfo. */
export function getForeignKeys(table: TableInfo): ForeignKeyInfo[] {
  const override = (table as TableWithMetadataOverrides)._foreignKeys;
  if (Array.isArray(override)) return override;

  try {
    return (table.foreign_key_constraints ?? []).map((bytes) => {
      const batch = deserializeBatch(bytes);
      const rows = [...iterRows(batch)];
      const row = rows[0];
      if (!row) return null;
      // fk_columns and pk_columns are list<utf8> — extract as arrays
      const fkCols = row.fk_columns;
      const pkCols = row.pk_columns;
      return {
        columns: Array.isArray(fkCols) ? fkCols : fkCols?.toArray?.() ?? [],
        referencedTable: row.referenced_table ?? "",
        referencedSchema: row.referenced_schema ?? "",
        referencedColumns: Array.isArray(pkCols) ? pkCols : pkCols?.toArray?.() ?? [],
      };
    }).filter((fk): fk is ForeignKeyInfo => fk !== null);
  } catch {
    return [];
  }
}

/** A catalog as discovered over RPC, with what is needed to attach it. */
export interface FetchedCatalog {
  catalog: CatalogData;
  /** Declared attach options (`catalogsInfo().attach_option_specs`). */
  specs: OptionSpecInfo[];
  /** The server's implementation version, when it reports one. */
  implementationVersion: string | null;
  /** True when the tree was NOT read over RPC and is left for DuckDB to fill
   *  in once the engine has attached the catalog (see `fetchCatalog`). */
  treeFromEngine: boolean;
  /** Every catalog the service lists, by server name. */
  availableCatalogs: string[];
}

/** Connect to a VGI service and fetch all catalog metadata.
 *
 *  The RPC tree is a preview: once the engine has attached the catalog, the
 *  inventory (`catalog-store.ts`) re-reads every database from DuckDB, and
 *  that is what the sidebar shows from then on. The RPC attach below carries
 *  no options, so it only matches what DuckDB attaches when there are none.
 *  With any option set (`hasOptions`), or a catalog that declares a
 *  `required` option (which refuses an option-less attach outright), the RPC
 *  attach is skipped and the tree comes from DuckDB alone: one source of
 *  truth, built from the same ATTACH the shell runs, rather than a second
 *  attach that has to replicate the options' typing in Arrow. */
export async function fetchCatalog(
  serviceUrl: string,
  { hasOptions = false, catalogName: requested }: { hasOptions?: boolean; catalogName?: string } = {},
): Promise<FetchedCatalog> {
  const token = await getAuthTokenForService(serviceUrl);
  console.log("[service] fetchCatalog:", serviceUrl, token ? "with token" : "NO TOKEN");
  const rpc = httpConnect(serviceUrl, {
    authorization: token ? `Bearer ${token}` : undefined,
  });
  const client = new VgiClient(rpc);

  try {
    // Discover catalogs, their declared options, and attach
    // A service may list several catalogs. A `?service=` link means its
    // first; a workspace names the one it wants.
    const infos = await client.catalogsInfo();
    const availableCatalogs = infos.map((i) => i.name);
    const info = requested ? infos.find((i) => i.name === requested) : infos[0];
    if (requested && !info) {
      throw new Error(`The service has no catalog named "${requested}"${availableCatalogs.length ? ` (it lists: ${availableCatalogs.join(", ")})` : ""}.`);
    }
    const catalogName = info?.name ?? "unknown";
    const specs = decodeOptionSpecs(info?.attach_option_specs);
    const implementationVersion = info?.implementation_version ?? null;
    if (hasOptions || specs.some((s) => s.required)) {
      return {
        catalog: { catalogName, catalogComment: null, catalogTags: {}, defaultSchema: null, schemas: [] },
        specs,
        implementationVersion,
        treeFromEngine: true,
        availableCatalogs,
      };
    }
    const attach = await client.catalogAttach(catalogName);
    const attachId = attach.attach_opaque_data;
    const defaultSchema = attach.default_schema ?? null;
    const catalogComment = attach.comment ?? null;
    const catalogTags = attach.tags ?? {};

    try {
      const schemas = await loadCatalogSchemas(client, attach);

      // Sort: default schema first, then alphabetical
      schemas.sort((a, b) => {
        if (a.info.name === defaultSchema) return -1;
        if (b.info.name === defaultSchema) return 1;
        return a.info.name.localeCompare(b.info.name);
      });

      return {
        catalog: { catalogName, catalogComment, catalogTags, defaultSchema, schemas },
        specs,
        implementationVersion,
        treeFromEngine: false,
        availableCatalogs,
      };
    } finally {
      await client.catalogDetach(attachId);
    }
  } finally {
    client.close();
  }
}

async function loadCatalogSchemas(
  client: VgiClient,
  attach: Awaited<ReturnType<VgiClient["catalogAttach"]>>,
): Promise<ResolvedSchema[]> {
  try {
    // The SDK checks supports_catalog_contents and falls back to per-schema
    // RPCs if the capability is absent or the bulk response fails validation.
    const snapshot = await client.loadCatalog(attach);
    return snapshot.schemas.map(contents => ({
      info: flattenSchemaInfo(contents.schema),
      tables: contents.tables.map(flattenTableInfo),
      views: contents.views.map(flattenViewInfo),
      functions: [
        ...contents.scalar_functions,
        ...contents.aggregate_functions,
        ...contents.table_functions,
      ].map(flattenFunctionInfo),
      macros: [...contents.scalar_macros, ...contents.table_macros].map(flattenMacroInfo),
    }));
  } catch {
    // Some older services omit optional listing endpoints. The SDK's complete
    // loader is strict; preserve Cupola's tolerant discovery for those services.
    const schemaInfos = await client.schemas(attach.attach_opaque_data);
    const attachId = attach.attach_opaque_data;
    // RPCs take the wire path; only Cupola's own model uses flattened names.
    return Promise.all(schemaInfos.map(async (wireInfo) => {
      const path = wireInfo.path;
      const [tables, views, scalarFunctions, aggregateFunctions, tableFunctions, scalarMacros, tableMacros] = await Promise.all([
        client.schemaContentsTables(attachId, path).catch(() => []),
        client.schemaContentsViews(attachId, path).catch(() => []),
        client.schemaContentsFunctions(attachId, path, "SCALAR_FUNCTION").catch(() => []),
        client.schemaContentsFunctions(attachId, path, "AGGREGATE_FUNCTION").catch(() => []),
        client.schemaContentsFunctions(attachId, path, "TABLE_FUNCTION").catch(() => []),
        client.schemaContentsMacros(attachId, path, "SCALAR_MACRO").catch(() => []),
        client.schemaContentsMacros(attachId, path, "TABLE_MACRO").catch(() => []),
      ]);
      return {
        info: flattenSchemaInfo(wireInfo),
        tables: tables.map(flattenTableInfo),
        views: views.map(flattenViewInfo),
        functions: [...scalarFunctions, ...aggregateFunctions, ...tableFunctions].map(flattenFunctionInfo),
        macros: [...scalarMacros, ...tableMacros].map(flattenMacroInfo),
      } satisfies ResolvedSchema;
    }));
  }
}

/** Just the declared attach options of a service's first catalog, for the
 *  connect form. Null when the server cannot be reached or refuses an
 *  anonymous discovery call (the form then offers raw text only). */
export async function fetchCatalogSpecs(serviceUrl: string): Promise<{ catalogName: string; specs: OptionSpecInfo[] } | null> {
  let client: VgiClient | null = null;
  try {
    const token = await getAuthTokenForService(serviceUrl);
    client = new VgiClient(httpConnect(serviceUrl, { authorization: token ? `Bearer ${token}` : undefined }));
    const info = (await client.catalogsInfo())[0];
    if (!info) return null;
    return { catalogName: info.name, specs: decodeOptionSpecs(info.attach_option_specs) };
  } catch (error) {
    console.warn("[service] could not read attach option specs:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    client?.close();
  }
}

/** Every catalog a service lists, with its declared attach options: the
 *  picker's "Attach a catalog…" form and its Test connection. A failure is
 *  returned, not thrown, with whether signing in would help. */
export async function fetchServiceCatalogs(serviceUrl: string): Promise<
  | { ok: true; catalogs: { name: string; specs: OptionSpecInfo[] }[] }
  | { ok: false; error: string; signInRequired: boolean }
> {
  let client: VgiClient | null = null;
  try {
    const token = await getAuthTokenForService(serviceUrl);
    client = new VgiClient(httpConnect(serviceUrl, { authorization: token ? `Bearer ${token}` : undefined }));
    const infos = await client.catalogsInfo();
    return { ok: true, catalogs: infos.map((info) => ({ name: info.name, specs: decodeOptionSpecs(info.attach_option_specs) })) };
  } catch (error) {
    const message = connectionErrorMessage(error, serviceUrl);
    return { ok: false, error: message, signInRequired: isRecoverableAuthError(message) };
  } finally {
    client?.close();
  }
}

/** The workspace manager's Test connection: `catalogsInfo` over RPC, timed,
 *  then (when the catalog needs no options to attach) the number of schemas
 *  it serves. A catalog with a required option is not attached here: the RPC
 *  attach carries no options, so its count would be wrong or an error. */
export async function testServiceConnection(serviceUrl: string, catalogName: string): Promise<ConnectionTest> {
  const started = performance.now();
  let client: VgiClient | null = null;
  try {
    const token = await getAuthTokenForService(serviceUrl);
    client = new VgiClient(httpConnect(serviceUrl, { authorization: token ? `Bearer ${token}` : undefined }));
    const infos = await client.catalogsInfo();
    const latencyMs = performance.now() - started;
    const catalogs = infos.map((i) => i.name);
    const info = catalogName ? infos.find((i) => i.name === catalogName) : infos[0];
    if (!info) return { ok: true, latencyMs, catalogFound: false, catalogs, schemaCount: null };
    if (decodeOptionSpecs(info.attach_option_specs).some((s) => s.required)) {
      return { ok: true, latencyMs, catalogFound: true, catalogs, schemaCount: null, schemaNote: "schemas are counted once it is attached with its required options" };
    }
    try {
      const attach = await client.catalogAttach(info.name);
      const schemas = await client.schemas(attach.attach_opaque_data);
      await client.catalogDetach(attach.attach_opaque_data).catch(() => {});
      return { ok: true, latencyMs, catalogFound: true, catalogs, schemaCount: schemas.length };
    } catch (error) {
      return { ok: true, latencyMs, catalogFound: true, catalogs, schemaCount: null, schemaNote: `schemas not listed: ${error instanceof Error ? error.message : String(error)}` };
    }
  } catch (error) {
    const message = connectionErrorMessage(error, serviceUrl);
    return { ok: false, latencyMs: performance.now() - started, error: message, signInRequired: isRecoverableAuthError(message) };
  } finally {
    client?.close();
  }
}

/** Per-column statistics from vgi_table_statistics(). */
export interface ColumnStats {
  columnType: string;
  min: unknown;
  max: unknown;
  hasNull: boolean;
  hasNotNull: boolean;
  distinctCount: number;
}

/**
 * Fetch column statistics via the DuckDB WASM shell bridge.
 * Returns null if the shell isn't running, the query fails, or the table has no stats.
 */
export async function fetchColumnStats(
  catalogName: string,
  schemaName: string,
  tableName: string,
): Promise<Map<string, ColumnStats> | null> {
  if (!engine.query || !engine.attached) return null;
  // Wait for ATTACH + USE to complete. vgi_table_statistics() resolves
  // against the current catalog; firing pre-ATTACH returns "Catalog not found".
  await engine.attached;
  try {
    const sql = `SELECT column_name, column_type, min, max, has_null, has_not_null, distinct_count FROM vgi_table_statistics('${esc(catalogName)}', '${esc(schemaName)}', '${esc(tableName)}')`;
    const rows = await readRows(sql);
    if (!rows || rows.length === 0) return null;
    const stats = new Map<string, ColumnStats>();
    for (const row of rows) {
      stats.set(String(row.column_name ?? ""), {
        columnType: String(row.column_type ?? ""),
        min: row.min ?? null,
        max: row.max ?? null,
        hasNull: Boolean(row.has_null),
        hasNotNull: Boolean(row.has_not_null),
        distinctCount: Number(row.distinct_count ?? -1),
      });
    }
    return stats;
  } catch (e) {
    console.error("Failed to fetch column statistics:", e);
    return null;
  }
}

/** Query result page from a table function call. */
export interface QueryPage {
  columns: string[];
  rows: Record<string, unknown>[];
  hasMore: boolean;
  totalFetched: number;
}

const PAGE_SIZE = 50;

/**
 * Create a paginated table query session.
 * Returns an object with `loadNextPage()` and `close()` methods.
 * Each call to `loadNextPage()` fetches the next PAGE_SIZE rows.
 */
export async function createTableQuery(
  serviceUrl: string,
  catalogName: string,
  functionName: string,
) {
  const token = await getAuthTokenForService(serviceUrl);
  const rpc = httpConnect(serviceUrl, {
    authorization: token ? `Bearer ${token}` : undefined,
  });
  const client = new VgiClient(rpc);

  let iterator: AsyncIterator<Record<string, unknown>[]> | null = null;
  let columns: string[] = [];
  let totalFetched = 0;
  let exhausted = false;
  let attached = false;

  async function ensureAttached() {
    if (!attached) {
      await client.catalogAttach(catalogName);
      attached = true;
      iterator = client.tableFunctionRows({
        functionName,
        arguments: new Arguments(),
      })[Symbol.asyncIterator]();
    }
  }

  // Buffer for rows from partial batches
  let buffer: Record<string, unknown>[] = [];

  async function loadNextPage(): Promise<QueryPage> {
    await ensureAttached();
    if (exhausted) {
      return { columns, rows: [], hasMore: false, totalFetched };
    }

    const pageRows: Record<string, unknown>[] = [...buffer];
    buffer = [];

    while (pageRows.length < PAGE_SIZE && !exhausted) {
      const result = await iterator!.next();
      if (result.done) {
        exhausted = true;
        break;
      }
      for (const row of result.value) {
        if (columns.length === 0) {
          columns = Object.keys(row);
        }
        if (pageRows.length < PAGE_SIZE) {
          pageRows.push(row);
        } else {
          buffer.push(row);
        }
      }
    }

    totalFetched += pageRows.length;
    return {
      columns,
      rows: pageRows,
      hasMore: !exhausted || buffer.length > 0,
      totalFetched,
    };
  }

  function close() {
    client.close();
  }

  return { loadNextPage, close };
}
