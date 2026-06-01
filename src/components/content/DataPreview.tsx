import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, ChevronsLeft, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataGrid } from "./DataGrid";
import type { ColumnInfo } from "@/lib/service";
import { arrowFieldToDuckDB } from "@/lib/arrow-to-duckdb";
import { safeGetArrowValue } from "@/lib/format";
import { tableFromIPC } from "apache-arrow";
import { bridge, onQueryChange } from "@/lib/shell-bridge";

/**
 * Wait until DuckDB can serve the given tablePath:
 *   - bridge.query must be live (worker booted)
 *   - if the table lives in the primary VGI catalog, ATTACH + USE must have
 *     completed (bridge.attached resolved). Tables in memory or
 *     secondary-attached catalogs only need bridge.query.
 *
 * Without the attached gate, a click on a VGI-catalog table immediately after
 * page load fires a query against an unattached DB and caches the resulting
 * ORDER BY ALL fallback as the wrong choice for the table's lifetime.
 */
function waitForTableReady(tablePath: string): Promise<void> {
  const firstSegment = tablePath.split(".")[0];
  const needsAttached = !!bridge.catalogName && firstSegment === bridge.catalogName;
  const queryReady: Promise<void> = bridge.query
    ? Promise.resolve()
    : new Promise((resolve) => {
        const unsubscribe = onQueryChange(() => {
          if (bridge.query) { unsubscribe(); resolve(); }
        });
      });
  return needsAttached && bridge.attached
    ? Promise.all([queryReady, bridge.attached]).then(() => {})
    : queryReady;
}

const PAGE_SIZES = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;

interface Props {
  /** Fully qualified table path: catalog.schema.table. Server-paginated. */
  tablePath?: string;
  /**
   * An already-materialized Arrow table (e.g. the last shell query result)
   * to preview instead of a tablePath. Paginated client-side by slicing the
   * in-memory table — no re-execution, so it shows exactly what produced it.
   */
  result?: any;
}

async function queryDuckDB(sql: string): Promise<{ table: any; error?: string }> {
  // DataPreview needs to distinguish three states that the generic readTable
  // collapses: bridge not ready (UX hint), query failed (surface error
  // verbatim), and empty success (table: null with no error). Decode is
  // the same single-buffer / Uint8Array dance — using the static
  // tableFromIPC import standardized in duckdb-query.ts.
  const queryFn = bridge.query;
  if (!queryFn) return { table: null, error: "DuckDB shell not initialized. Open the SQL Shell tab first." };
  const result = await queryFn(sql);
  if (!result.ok) return { table: null, error: result.error || "Query failed" };
  const buf = result.arrowBuffers?.[0];
  if (!buf) return { table: null };
  return { table: tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf) };
}

/**
 * Resolve a deterministic ORDER BY expression for stable LIMIT/OFFSET
 * pagination on the given tablePath. Walks the ladder:
 *
 *   1. `rowid`         — try `SELECT rowid FROM <t> LIMIT 1`. DuckDB's
 *                        rowid pseudo-column is stable on physical tables;
 *                        the VGI extension exposes it for sources that
 *                        provide a stable identity.
 *   2. PK columns      — fall back to the primary-key columns from
 *                        `PRAGMA table_info('<t>')`. Skip this rung if no
 *                        column is marked pk > 0.
 *   3. `ALL`           — final fallback. `ORDER BY ALL` sorts by every
 *                        output column. Always works on a non-empty schema.
 *
 * Returns a string ready to splice after `ORDER BY`. Result is cached by
 * caller per tablePath so the probe only fires once per selection.
 */
async function resolveOrderBy(tablePath: string): Promise<string> {
  // Each rung returns a complete ORDER BY clause body (everything after
  // the words "ORDER BY"), including ASC NULLS LAST modifiers, so the
  // caller can splice it without per-rung knowledge.

  // Rung 1: rowid. The caller is responsible for ensuring bridge.query is
  // set before invoking us — otherwise the probe can't actually run and the
  // ladder will cascade to ALL incorrectly.
  if (!bridge.query) {
    throw new Error("resolveOrderBy called before bridge.query was ready");
  }
  const probe = await bridge.query(`SELECT rowid FROM ${tablePath} LIMIT 1`);
  if (probe?.ok) {
    console.log("[preview] orderBy resolved to rowid for", tablePath);
    return "rowid ASC NULLS LAST";
  }

  // Rung 2: primary-key columns from PRAGMA table_info. The PRAGMA returns
  // one row per column with a `pk` field that is the 1-based ordinal in
  // the PK (0 = not part of PK). Sort by ordinal to compose the ORDER BY
  // in PK-declaration order.
  try {
    const { table, error } = await queryDuckDB(`PRAGMA table_info('${tablePath.replace(/'/g, "''")}')`);
    if (!error && table && table.numRows > 0) {
      const nameCol = table.getChild("name");
      const pkCol = table.getChild("pk");
      const pkCols: Array<{ name: string; ord: number }> = [];
      for (let i = 0; i < table.numRows; i++) {
        const ord = Number(pkCol?.get(i) ?? 0);
        if (ord > 0) {
          pkCols.push({ name: String(nameCol?.get(i) ?? ""), ord });
        }
      }
      if (pkCols.length > 0) {
        pkCols.sort((a, b) => a.ord - b.ord);
        const expr = pkCols
          .map((c) => `"${c.name.replace(/"/g, '""')}" ASC NULLS LAST`)
          .join(", ");
        console.log("[preview] orderBy resolved to PK columns for", tablePath, ":", expr);
        return expr;
      }
    }
  } catch {
    // table_info itself can throw on some VGI sources; fall through to ALL.
  }

  // Rung 3: ORDER BY ALL.
  console.log("[preview] orderBy fell back to ALL for", tablePath);
  return "ALL ASC NULLS LAST";
}

function arrowTableToRows(table: any): { columns: string[]; columnInfo: ColumnInfo[]; arrowFields: any[]; rows: Record<string, any>[] } {
  const fields = table.schema.fields;
  const columns = fields.map((f: any) => f.name);
  const columnInfo: ColumnInfo[] = fields.map((f: any) => ({
    name: f.name,
    arrowType: f.type?.toString() || "unknown",
    duckdbType: arrowFieldToDuckDB(f),
    nullable: f.nullable,
  }));

  const rows: Record<string, any>[] = [];
  for (let r = 0; r < table.numRows; r++) {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      row[columns[c]] = safeGetArrowValue(table.getChildAt(c), r, fields[c]);
    }
    rows.push(row);
  }

  return { columns, columnInfo, arrowFields: fields, rows };
}

export function DataPreview({ tablePath, result }: Props) {
  const [columns, setColumns] = useState<string[]>([]);
  const [columnInfo, setColumnInfo] = useState<ColumnInfo[]>([]);
  const [arrowFields, setArrowFields] = useState<any[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [hasMore, setHasMore] = useState(false);
  // Known total row count. Available for client-side `result` previews
  // (the whole table is in memory); null for server-paginated tablePaths
  // where we deliberately avoid a COUNT(*).
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Infinite-scroll append in progress (distinct from the initial/window
  // `loading`). Used to show a footer spinner without blanking the grid.
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `page` is the base chunk the loaded window starts at. The footer pager
  // jumps it (replacing the window); infinite scroll appends below it.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const requestIdRef = useRef(0);
  // Live row count for async append offset math, kept off `rows` so loadMore
  // doesn't need `rows` in its deps (which would re-subscribe scroll handlers).
  const rowsCountRef = useRef(0);
  // Guards against overlapping appends (scroll + arrow can both fire).
  const appendingRef = useRef(false);
  // Cache resolved ORDER BY expression per tablePath so the probe ladder
  // only runs once per selection.
  const orderByCacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => { rowsCountRef.current = rows.length; }, [rows]);

  // Resolve (and cache) the deterministic ORDER BY for a tablePath. Shared by
  // window loads and appends so both page through the same stable ordering.
  const ensureOrderBy = useCallback(async (path: string): Promise<string> => {
    let orderBy = orderByCacheRef.current.get(path);
    if (!orderBy) {
      orderBy = await resolveOrderBy(path);
      orderByCacheRef.current.set(path, orderBy);
    }
    return orderBy;
  }, []);

  // Load a fresh window of `size` rows starting at chunk `pageNum`, REPLACING
  // the current rows. Used for the initial load, pager jumps, and page-size
  // changes. Bumps requestId so any in-flight append for the old window is
  // discarded.
  const loadWindow = useCallback(async (pageNum: number, size: number) => {
    const thisRequest = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      // Client-side preview of an in-memory Arrow result: slice the table.
      // No bridge/ATTACH/ORDER BY — the result is already materialized.
      if (result) {
        const total = result.numRows as number;
        const offset = pageNum * size;
        const slice = result.slice(offset, Math.min(offset + size, total));
        const { columns: cols, columnInfo: info, arrowFields: fields, rows: data } = arrowTableToRows(slice);
        setColumns(cols);
        setColumnInfo(info);
        setArrowFields(fields);
        setRows(data);
        setHasMore(offset + size < total);
        setTotalRows(total);
        return;
      }
      if (!tablePath) return;
      // Wait for the shell to be ready to query this specific table — for
      // VGI-catalog tables this awaits ATTACH+USE, not just bridge.query.
      // The orderBy probe must NOT run pre-ATTACH or it cascades to the ALL
      // fallback and caches that wrong choice for the table's lifetime.
      await waitForTableReady(tablePath);
      if (thisRequest !== requestIdRef.current) return; // stale, tablePath changed while waiting

      const orderBy = await ensureOrderBy(tablePath);
      if (thisRequest !== requestIdRef.current) return; // stale, changed mid-resolve

      const offset = pageNum * size;
      // Fetch N+1 rows: more than `size` back means at least one more chunk
      // exists below (we trim the extra row before display).
      const { table, error: queryError } = await queryDuckDB(
        `SELECT * FROM ${tablePath} ORDER BY ${orderBy} LIMIT ${size + 1} OFFSET ${offset}`
      );
      if (thisRequest !== requestIdRef.current) return; // stale response
      if (queryError) {
        setError(queryError);
        return;
      }
      if (!table || table.numRows === 0) {
        if (pageNum === 0) {
          setColumns([]);
          setColumnInfo([]);
          setRows([]);
        }
        setHasMore(false);
        return;
      }
      const { columns: cols, columnInfo: info, arrowFields: fields, rows: data } = arrowTableToRows(table);
      const more = data.length > size;
      const visible = more ? data.slice(0, size) : data;
      setColumns(cols);
      setColumnInfo(info);
      setArrowFields(fields);
      setRows(visible);
      setHasMore(more);
    } catch (err: any) {
      if (thisRequest !== requestIdRef.current) return;
      setError(err.message || "Failed to load data");
    } finally {
      if (thisRequest === requestIdRef.current) setLoading(false);
    }
  }, [tablePath, result, ensureOrderBy]);

  // Infinite scroll: APPEND the next `pageSize` rows below the loaded window.
  // Offset = base chunk (page*pageSize) + rows already loaded. Guarded so
  // scroll + arrow can't double-fire, and tied to the current window's
  // requestId so a window reset mid-flight discards the late append.
  const loadMore = useCallback(async () => {
    if (appendingRef.current) return;
    const windowRequest = requestIdRef.current;
    const offset = page * pageSize + rowsCountRef.current;
    appendingRef.current = true;
    setAppending(true);
    try {
      if (result) {
        const total = result.numRows as number;
        if (offset >= total) { setHasMore(false); return; }
        const slice = result.slice(offset, Math.min(offset + pageSize, total));
        const { rows: data } = arrowTableToRows(slice);
        setRows((prev) => [...prev, ...data]);
        setHasMore(offset + pageSize < total);
        return;
      }
      if (!tablePath) return;
      const orderBy = orderByCacheRef.current.get(tablePath);
      if (!orderBy) return; // window not loaded yet; nothing to extend
      const { table, error: queryError } = await queryDuckDB(
        `SELECT * FROM ${tablePath} ORDER BY ${orderBy} LIMIT ${pageSize + 1} OFFSET ${offset}`
      );
      if (windowRequest !== requestIdRef.current) return; // window changed; drop
      if (queryError) { setError(queryError); return; }
      if (!table || table.numRows === 0) { setHasMore(false); return; }
      const { rows: data } = arrowTableToRows(table);
      const more = data.length > pageSize;
      const visible = more ? data.slice(0, pageSize) : data;
      setRows((prev) => [...prev, ...visible]);
      setHasMore(more);
    } catch (err: any) {
      setError(err.message || "Failed to load more rows");
    } finally {
      appendingRef.current = false;
      setAppending(false);
    }
  }, [tablePath, result, page, pageSize]);

  // Reset and load the first window when the source or pageSize changes.
  useEffect(() => {
    setPage(0);
    setRows([]);
    setColumns([]);
    setHasMore(false);
    setTotalRows(null);
    void loadWindow(0, pageSize);
  }, [tablePath, result, loadWindow, pageSize]);

  // Pager jump — replace the loaded window with a fresh chunk at newPage.
  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
    setRows([]);
    loadWindow(newPage, pageSize);
  }, [loadWindow, pageSize]);

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(0);
    setRows([]);
    loadWindow(0, newSize);
  }, [loadWindow]);

  const startRow = page * pageSize;

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <AlertCircle className="h-8 w-8 text-destructive/60 mb-3" />
        <p className="text-sm font-medium text-destructive mb-1">Failed to load data</p>
        <p className="text-xs text-muted-foreground max-w-md">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setError(null); loadWindow(page, pageSize); }}
          className="mt-4 text-xs"
        >
          Retry
        </Button>
      </div>
    );
  }

  // Loading state (initial)
  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading data...</span>
      </div>
    );
  }

  // Empty state — only show when the FIRST page's fetch returned nothing.
  // Without COUNT(*) we can't distinguish "table is empty" from "user
  // navigated past the last page" except by the page index. The
  // happens-after-page-zero case shouldn't occur in practice because
  // `hasMore` disables Next at the boundary, but guard against it anyway.
  if (!loading && rows.length === 0 && page === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <Database className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">{result ? "No rows in this result" : "No rows in this table"}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Data grid — fills available space; DataGrid owns the scroll container
          so its sticky header pins to the actual scroller on vertical scroll. */}
      <div className="flex-1 min-h-0">
        <DataGrid
          columnNames={columns}
          columnInfo={columnInfo}
          arrowFields={arrowFields}
          rows={rows}
          startRow={startRow}
          borderless
          cellNavigation
          canLoadMore={hasMore && !loading}
          onLoadMore={loadMore}
        />
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-card shrink-0">
        {/* Left: row info */}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {loading || appending ? (
            <Loader2 className="h-3 w-3 animate-spin inline mr-1" />
          ) : null}
          Rows {startRow + 1}&ndash;{startRow + rows.length}
          {totalRows != null ? ` of ${totalRows.toLocaleString()}` : ""}
        </span>

        {/* Center: page controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(0)}
            disabled={page === 0 || loading}
            className="h-7 w-7 p-0"
            title="First page"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 0 || loading}
            className="h-7 w-7 p-0"
            title="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground px-2 whitespace-nowrap">
            Page {page + 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(page + 1)}
            disabled={loading || !hasMore}
            className="h-7 w-7 p-0"
            title="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Right: page size selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(val) => handlePageSizeChange(Number(val))}
          >
            <SelectTrigger className="h-7 w-[70px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)} className="text-xs">
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
