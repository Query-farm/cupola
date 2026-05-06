/**
 * VGI service wrapper — connects to a VGI HTTP server and fetches catalog metadata.
 */

// Import from client-only connect alias to avoid bundling Node.js server-side code.
// See astro.config.mjs for the alias resolution.
import { httpConnect } from "@query-farm/vgi-rpc/connect";
import { VgiClient, Arguments, deserializeSchema, deserializeBatch, iterRows } from "vgi/client";
import type {
  AttachId,
  SchemaInfo,
  TableInfo,
  ViewInfo,
  FunctionInfo,
  MacroInfo,
  CatalogAttachResult,
} from "vgi/client";
import { getAuthToken, getAuthTokenForService } from "./auth";
import { arrowFieldToDuckDB } from "./arrow-to-duckdb";
import { bridge } from "./shell-bridge";

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
}

/** Parsed foreign key constraint. */
export interface ForeignKeyInfo {
  columns: string[];
  referencedTable: string;
  referencedSchema: string;
  referencedColumns: string[];
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
  catalogName: string;
  catalogComment: string | null;
  catalogTags: Record<string, string>;
  defaultSchema: string | null;
  schemas: ResolvedSchema[];
}

/** Get the VGI service URL from ?service= param or fall back to current origin. */
export function getServiceUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("service") || window.location.origin;
}

/** Whether a ?service= URL parameter was explicitly provided. */
export function hasExplicitService(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("service");
}

/** Read the `?attach_options=` URL parameter, if present.
 *  Returns `undefined` when the param is absent (caller should fall back to
 *  the localStorage value), or the (possibly empty) decoded string when set.
 *  An explicit empty value clears any previously saved options. */
export function getAttachOptionsFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("attach_options")) return undefined;
  return params.get("attach_options") ?? "";
}

/** Extract column info from a TableInfo's serialized Arrow schema bytes.
 *  Also supports a pre-built _columnInfo override (used for in-memory tables). */
export function getColumns(table: TableInfo): ColumnInfo[] {
  // Check for pre-built column info (e.g., from DuckDB memory tables)
  const override = (table as any)._columnInfo;
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

/** Parse foreign key constraints from a TableInfo. */
export function getForeignKeys(table: TableInfo): ForeignKeyInfo[] {
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

/** Connect to a VGI service and fetch all catalog metadata. */
export async function fetchCatalog(serviceUrl: string): Promise<CatalogData> {
  const token = await getAuthTokenForService(serviceUrl);
  console.log("[service] fetchCatalog:", serviceUrl, token ? "with token" : "NO TOKEN");
  const rpc = httpConnect(serviceUrl, {
    authorization: token ? `Bearer ${token}` : undefined,
  });
  const client = new VgiClient(rpc);

  try {
    // Discover catalogs and attach
    const catalogs = await client.catalogs();
    const catalogName = catalogs[0] ?? "unknown";
    const attach = await client.catalogAttach(catalogName);
    const attachId = attach.attach_id;
    const defaultSchema = attach.default_schema ?? null;
    const catalogComment = attach.comment ?? null;
    const catalogTags = attach.tags ?? {};

    // Fetch all schemas
    const schemaInfos = await client.schemas(attachId);

    // Fetch contents for each schema in parallel
    const schemas = await Promise.all(
      schemaInfos.map(async (info) => {
        const [tables, views, functions, scalarMacros, tableMacros] = await Promise.all([
          client.schemaContentsTables(attachId, info.name).catch(() => []),
          client.schemaContentsViews(attachId, info.name).catch(() => []),
          client
            .schemaContentsFunctions(attachId, info.name, "TABLE_FUNCTION")
            .catch(() => []),
          client.schemaContentsMacros(attachId, info.name, "SCALAR_MACRO").catch(() => []),
          client.schemaContentsMacros(attachId, info.name, "TABLE_MACRO").catch(() => []),
        ]);
        const macros = [...scalarMacros, ...tableMacros];
        return { info, tables, views, functions, macros } as ResolvedSchema;
      })
    );

    // Sort: default schema first, then alphabetical
    schemas.sort((a, b) => {
      if (a.info.name === defaultSchema) return -1;
      if (b.info.name === defaultSchema) return 1;
      return a.info.name.localeCompare(b.info.name);
    });

    await client.catalogDetach(attachId);
    return { catalogName, catalogComment, catalogTags, defaultSchema, schemas };
  } finally {
    client.close();
  }
}

/** Per-column statistics from vgi_table_statistics(). */
export interface ColumnStats {
  columnType: string;
  min: any;
  max: any;
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
  const queryFn = bridge.query;
  if (!queryFn) return null;

  try {
    const esc = (s: string) => s.replace(/'/g, "''");
    const sql = `SELECT column_name, column_type, min, max, has_null, has_not_null, distinct_count FROM vgi_table_statistics('${esc(catalogName)}', '${esc(schemaName)}', '${esc(tableName)}')`;

    const result = await queryFn(sql);
    if (!result.ok || !result.arrowBuffers?.length) return null;

    const { tableFromIPC } = await import("apache-arrow");
    const buf = result.arrowBuffers[0];
    const table = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
    if (table.numRows === 0) return null;

    const stats = new Map<string, ColumnStats>();
    for (let i = 0; i < table.numRows; i++) {
      const columnName = String(table.getChildAt(0)?.get(i) ?? "");
      stats.set(columnName, {
        columnType: String(table.getChildAt(1)?.get(i) ?? ""),
        min: table.getChildAt(2)?.get(i) ?? null,
        max: table.getChildAt(3)?.get(i) ?? null,
        hasNull: Boolean(table.getChildAt(4)?.get(i)),
        hasNotNull: Boolean(table.getChildAt(5)?.get(i)),
        distinctCount: Number(table.getChildAt(6)?.get(i) ?? -1),
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
  rows: Record<string, any>[];
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

  let iterator: AsyncIterator<Record<string, any>[]> | null = null;
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
  let buffer: Record<string, any>[] = [];

  async function loadNextPage(): Promise<QueryPage> {
    await ensureAttached();
    if (exhausted) {
      return { columns, rows: [], hasMore: false, totalFetched };
    }

    const pageRows: Record<string, any>[] = [...buffer];
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
