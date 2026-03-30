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
  CatalogAttachResult,
} from "vgi/client";
import { getAuthToken } from "./auth";
import { arrowFieldToDuckDB } from "./arrow-to-duckdb";

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
}

/** Full catalog data ready for rendering. */
export interface CatalogData {
  catalogName: string;
  defaultSchema: string | null;
  schemas: ResolvedSchema[];
}

/** Get the VGI service URL from ?service= param or fall back to current origin. */
export function getServiceUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("service") || window.location.origin;
}

/** Extract column info from a TableInfo's serialized Arrow schema bytes. */
export function getColumns(table: TableInfo): ColumnInfo[] {
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
    return table.foreignKeyConstraints.map((bytes) => {
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
  const token = getAuthToken();
  const rpc = httpConnect(serviceUrl, {
    authorization: token ? `Bearer ${token}` : undefined,
  });
  const client = new VgiClient(rpc);

  try {
    // Discover catalogs and attach
    const catalogs = await client.catalogs();
    const catalogName = catalogs[0] ?? "unknown";
    const attach = await client.catalogAttach(catalogName);
    const attachId = attach.attachId;
    const defaultSchema = attach.defaultSchema ?? null;

    // Fetch all schemas
    const schemaInfos = await client.schemas(attachId);

    // Fetch contents for each schema in parallel
    const schemas = await Promise.all(
      schemaInfos.map(async (info) => {
        const [tables, views, functions] = await Promise.all([
          client.schemaContentsTables(attachId, info.name).catch(() => []),
          client.schemaContentsViews(attachId, info.name).catch(() => []),
          client
            .schemaContentsFunctions(attachId, info.name, "TABLE_FUNCTION")
            .catch(() => []),
        ]);
        return { info, tables, views, functions } as ResolvedSchema;
      })
    );

    // Sort: default schema first, then alphabetical
    schemas.sort((a, b) => {
      if (a.info.name === defaultSchema) return -1;
      if (b.info.name === defaultSchema) return 1;
      return a.info.name.localeCompare(b.info.name);
    });

    await client.catalogDetach(attachId);
    return { catalogName, defaultSchema, schemas };
  } finally {
    client.close();
  }
}

/** Query result from a table function call. */
export interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  truncated: boolean;
}

const MAX_PREVIEW_ROWS = 100;

/** Fetch preview rows from a table by calling its backing table function. */
export async function queryTable(
  serviceUrl: string,
  catalogName: string,
  functionName: string,
): Promise<QueryResult> {
  const token = getAuthToken();
  const rpc = httpConnect(serviceUrl, {
    authorization: token ? `Bearer ${token}` : undefined,
  });
  const client = new VgiClient(rpc);

  try {
    const attach = await client.catalogAttach(catalogName);
    const rows: Record<string, any>[] = [];
    let columns: string[] = [];
    let truncated = false;

    for await (const batch of client.tableFunctionRows({
      functionName,
      arguments: new Arguments(),
    })) {
      for (const row of batch) {
        if (columns.length === 0) {
          columns = Object.keys(row);
        }
        if (rows.length >= MAX_PREVIEW_ROWS) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      if (truncated) break;
    }

    await client.catalogDetach(attach.attachId);
    return { columns, rows, truncated };
  } finally {
    client.close();
  }
}
