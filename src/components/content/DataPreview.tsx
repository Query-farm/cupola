import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, ChevronsLeft, Database, Table2, Rows3, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataGrid, type Cell } from "./DataGrid";
import { DataRecords } from "./DataRecords";
import { ValueInspector } from "./ValueInspector";
import type { ColumnInfo } from "@/lib/service";
import { arrowFieldToDuckDB } from "@/lib/arrow-to-duckdb";
import { safeGetArrowValue } from "@/lib/format";
import { useSettings } from "@/lib/settings";

const PAGE_SIZES = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;

interface Props {
  /**
   * An already-materialized Arrow table (an editor or shell result).
   * Paginated client-side by slicing the in-memory table — no re-execution,
   * so it shows exactly what produced it.
   */
  result: any;
}

function arrowTableMeta(table: any): { columns: string[]; columnInfo: ColumnInfo[]; arrowFields: any[] } {
  const fields = table.schema.fields;
  const columns = fields.map((f: any) => f.name);
  const columnInfo: ColumnInfo[] = fields.map((f: any) => ({
    name: f.name,
    arrowType: f.type?.toString() || "unknown",
    duckdbType: arrowFieldToDuckDB(f),
    nullable: f.nullable,
    comment: f.metadata?.get("comment") ?? undefined,
  }));
  return { columns, columnInfo, arrowFields: fields };
}

function arrowTableToRows(table: any): { columns: string[]; columnInfo: ColumnInfo[]; arrowFields: any[]; rows: Record<string, any>[] } {
  const meta = arrowTableMeta(table);
  const fields = meta.arrowFields;
  const rows: Record<string, any>[] = [];
  for (let r = 0; r < table.numRows; r++) {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      row[meta.columns[c]] = safeGetArrowValue(table.getChildAt(c), r, fields[c]);
    }
    rows.push(row);
  }
  return { ...meta, rows };
}

/** Materialize specific row indices from a full Arrow table (used to page over
 *  a client-side sort permutation without slicing). */
function arrowRowsByIndices(table: any, indices: number[]): Record<string, any>[] {
  const fields = table.schema.fields;
  const names = fields.map((f: any) => f.name);
  const children = fields.map((_: any, c: number) => table.getChildAt(c));
  return indices.map((idx) => {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      row[names[c]] = safeGetArrowValue(children[c], idx, fields[c]);
    }
    return row;
  });
}

type SortState = { col: string; dir: "asc" | "desc" } | null;

/** Comparator over row indices of an in-memory Arrow table for the given sort.
 *  Nulls always sort last; numbers/bigints numeric, dates by time, else string. */
function makeIndexComparator(table: any, col: string, dir: "asc" | "desc"): (a: number, b: number) => number {
  const fields = table.schema.fields;
  const cIdx = fields.findIndex((f: any) => f.name === col);
  const child = table.getChildAt(cIdx);
  const field = fields[cIdx];
  const sign = dir === "desc" ? -1 : 1;
  return (a, b) => {
    const va = safeGetArrowValue(child, a, field);
    const vb = safeGetArrowValue(child, b, field);
    const na = va === null || va === undefined;
    const nb = vb === null || vb === undefined;
    if (na && nb) return 0;
    if (na) return 1; // nulls last, independent of direction
    if (nb) return -1;
    let cmp: number;
    if (typeof va === "bigint" || typeof vb === "bigint") {
      const ba = typeof va === "bigint" ? va : BigInt(Math.trunc(Number(va)));
      const bb = typeof vb === "bigint" ? vb : BigInt(Math.trunc(Number(vb)));
      cmp = ba < bb ? -1 : ba > bb ? 1 : 0;
    } else if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else if (typeof va.__rawDays === "number" && typeof vb.__rawDays === "number") {
      // Date32 values are wrapped by safeGetArrowValue to preserve DuckDB's
      // full date range. Compare days directly, including infinity sentinels.
      cmp = va.__rawDays - vb.__rawDays;
    } else if (va instanceof Date && vb instanceof Date) {
      cmp = va.getTime() - vb.getTime();
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return sign * cmp;
  };
}

export function DataPreview({ result }: Props) {
  const { settings, updateSettings } = useSettings();
  const [columns, setColumns] = useState<string[]>([]);
  const [columnInfo, setColumnInfo] = useState<ColumnInfo[]>([]);
  const [arrowFields, setArrowFields] = useState<any[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [hasMore, setHasMore] = useState(false);
  // Total row count (the whole table is in memory).
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Infinite-scroll append in progress (distinct from the initial/window
  // `loading`). Used to show a footer spinner without blanking the grid.
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `page` is the base chunk the loaded window starts at. The footer pager
  // jumps it (replacing the window); infinite scroll appends below it.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() =>
    PAGE_SIZES.includes(settings.previewRowsPerPage) ? settings.previewRowsPerPage : DEFAULT_PAGE_SIZE,
  );
  // Active column sort. null = source's natural/stable order.
  const [sort, setSort] = useState<SortState>(null);
  // Cached sort permutation (computed once per table+column+direction so
  // paging doesn't re-sort every window).
  const sortedIndicesRef = useRef<{ table: any; col: string; dir: string; indices: number[] } | null>(null);
  const requestIdRef = useRef(0);
  const layout = settings.previewLayout === "lines" ? "lines" : "grid";
  // The grid's active cell, and whether the value panel is open on it. The
  // panel follows the active cell as it moves.
  const [activeCell, setActiveCell] = useState<Cell | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const openCell = useCallback((cell: Cell) => { setActiveCell(cell); setInspecting(true); }, []);
  // Live row count for async append offset math, kept off `rows` so loadMore
  // doesn't need `rows` in its deps (which would re-subscribe scroll handlers).
  const rowsCountRef = useRef(0);
  // Guards against overlapping appends (scroll + arrow can both fire).
  const appendingRef = useRef(false);
  useEffect(() => { rowsCountRef.current = rows.length; }, [rows]);

  // Sorted row-index permutation for the in-memory result, cached per
  // (table, column, direction).
  const getSortedIndices = useCallback((table: any, s: NonNullable<SortState>): number[] => {
    const cached = sortedIndicesRef.current;
    if (cached && cached.table === table && cached.col === s.col && cached.dir === s.dir) {
      return cached.indices;
    }
    const indices = Array.from({ length: table.numRows as number }, (_, i) => i);
    indices.sort(makeIndexComparator(table, s.col, s.dir));
    sortedIndicesRef.current = { table, col: s.col, dir: s.dir, indices };
    return indices;
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
      const total = result.numRows as number;
      const offset = pageNum * size;
      const { columns: cols, columnInfo: info, arrowFields: fields } = arrowTableMeta(result);
      let data: Record<string, any>[];
      if (sort) {
        // Page over the sorted permutation, gathering rows by index.
        const pageIdx = getSortedIndices(result, sort).slice(offset, offset + size);
        data = arrowRowsByIndices(result, pageIdx);
      } else {
        // Natural order — slice the contiguous Arrow table (fast path).
        data = arrowTableToRows(result.slice(offset, Math.min(offset + size, total))).rows;
      }
      setColumns(cols);
      setColumnInfo(info);
      setArrowFields(fields);
      setRows(data);
      setHasMore(offset + size < total);
      setTotalRows(total);
    } catch (err: any) {
      if (thisRequest !== requestIdRef.current) return;
      setError(err.message || "Failed to load data");
    } finally {
      if (thisRequest === requestIdRef.current) setLoading(false);
    }
  }, [result, sort, getSortedIndices]);

  // Infinite scroll: APPEND the next `pageSize` rows below the loaded window.
  // Offset = base chunk (page*pageSize) + rows already loaded. Guarded so
  // scroll + arrow can't double-fire.
  const loadMore = useCallback(async () => {
    if (appendingRef.current) return;
    const offset = page * pageSize + rowsCountRef.current;
    appendingRef.current = true;
    setAppending(true);
    try {
      const total = result.numRows as number;
      if (offset >= total) { setHasMore(false); return; }
      const data = sort
        ? arrowRowsByIndices(result, getSortedIndices(result, sort).slice(offset, offset + pageSize))
        : arrowTableToRows(result.slice(offset, Math.min(offset + pageSize, total))).rows;
      setRows((prev) => [...prev, ...data]);
      setHasMore(offset + pageSize < total);
    } catch (err: any) {
      setError(err.message || "Failed to load more rows");
    } finally {
      appendingRef.current = false;
      setAppending(false);
    }
  }, [result, page, pageSize, sort, getSortedIndices]);

  // Reset and load the first window when the source or pageSize changes.
  useEffect(() => {
    setPage(0);
    setRows([]);
    setColumns([]);
    setHasMore(false);
    setTotalRows(null);
    void loadWindow(0, pageSize);
  }, [result, loadWindow, pageSize]);

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
    updateSettings({ previewRowsPerPage: newSize });
    loadWindow(0, newSize);
  }, [loadWindow, updateSettings]);

  // Cycle a column's sort: none → asc → desc → none. The reset effect (keyed on
  // loadWindow, which depends on `sort`) reloads from page 0.
  const handleSort = useCallback((col: string) => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  }, []);

  const startRow = page * pageSize;

  const inspected = activeCell && activeCell.row < rows.length && activeCell.col < columns.length
    ? {
        ...activeCell,
        column: columns[activeCell.col],
        value: rows[activeCell.row][columns[activeCell.col]],
      }
    : null;

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

  // Empty state — only for an empty result, not a page past the end.
  if (!loading && rows.length === 0 && page === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <Database className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No rows in this result</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Data grid — fills available space; DataGrid owns the scroll container
          so its sticky header pins to the actual scroller on vertical scroll. */}
      <div
        className="flex-1 min-h-0 flex"
        onKeyDown={(e) => { if (e.key === "Escape" && inspecting) { e.stopPropagation(); setInspecting(false); } }}
      >
        {layout === "lines" ? (
        <div className="flex-1 min-w-0">
        <DataRecords
          // Re-mount on a window reset so scroll and expanded values start over.
          key={`${startRow}:${sort?.col ?? ""}:${sort?.dir ?? ""}`}
          columnNames={columns}
          columnInfo={columnInfo}
          arrowFields={arrowFields}
          rows={rows}
          startRow={startRow}
          totalRows={totalRows}
          canLoadMore={hasMore && !loading}
          onLoadMore={loadMore}
          geometryAsText={settings.geometryAsText}
          numberGrouping={settings.numberGrouping}
        />
        </div>
        ) : (
        <>
        <div className="flex-1 min-w-0">
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
          geometryAsText={settings.geometryAsText}
          numberGrouping={settings.numberGrouping}
          sort={sort}
          onSort={handleSort}
          onActiveCellChange={setActiveCell}
          onCellOpen={openCell}
        />
        </div>
        {inspecting && (
          <div className="w-[40%] max-w-[560px] min-w-[240px] shrink-0">
            {inspected ? (
            <ValueInspector
              column={inspected.column}
              info={columnInfo[inspected.col]}
              field={arrowFields[inspected.col]}
              value={inspected.value}
              rowNumber={startRow + inspected.row + 1}
              numberGrouping={settings.numberGrouping}
              onClose={() => setInspecting(false)}
            />
            ) : (
              <div className="flex h-full items-center justify-center border-l border-border bg-card p-4 text-center text-xs text-muted-foreground">
                Select a cell to see its full value.
              </div>
            )}
          </div>
        )}
        </>
        )}
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

        {/* Right: layout + page size selector */}
        <div className="flex items-center gap-2">
          {layout === "grid" && (
            <Button
              variant={inspecting ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setInspecting((v) => !v)}
              className="h-7 w-7 p-0"
              title="Value panel: the selected cell's full value (double-click or Enter on a cell)"
              aria-pressed={inspecting}
              aria-label="Value panel"
            >
              <PanelRight className="h-3.5 w-3.5" />
            </Button>
          )}
          <div className="flex items-center rounded-md border border-border p-0.5" role="radiogroup" aria-label="Results layout">
            {([
              ["grid", Table2, "Grid layout", "Grid"],
              ["lines", Rows3, "Lines layout", "Lines: one block per row, values shown in full"],
            ] as const).map(([value, Icon, name, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={layout === value}
                aria-label={name}
                title={label}
                onClick={() => updateSettings({ previewLayout: value })}
                className={`h-6 w-7 inline-flex items-center justify-center rounded-sm cursor-pointer transition-colors ${
                  layout === value ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
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
