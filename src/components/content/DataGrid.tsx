import { useMemo, useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCellValue, isNullValue } from "@/lib/format";
import type { ColumnInfo } from "@/lib/service";
import { GeometryViewer } from "./GeometryViewer";

interface Props {
  columnNames: string[];
  columnInfo?: ColumnInfo[];
  arrowFields?: any[];
  rows: Record<string, any>[];
  startRow?: number;
  /** Remove outer border and rounding for embedding in full-bleed containers. */
  borderless?: boolean;
  /**
   * Enable keyboard cell navigation: a highlighted active cell that moves with
   * the arrow keys (Home/End jump to the row's first/last column).
   */
  cellNavigation?: boolean;
  /**
   * Infinite scroll. When more rows are available below the loaded set
   * (`canLoadMore`), the grid calls `onLoadMore` to append the next chunk —
   * either when the user scrolls near the bottom or arrows Down past the last
   * loaded row. `rows` is expected to GROW (accumulate), not be replaced; on
   * an arrow-driven load the cursor advances onto the first newly-loaded row.
   */
  canLoadMore?: boolean;
  onLoadMore?: () => void;
}

/** DuckDB types that should be right-aligned. */
const NUMERIC_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
  "FLOAT", "DOUBLE", "DECIMAL",
  "HUGEINT", "UHUGEINT", "BIGNUM", "VARINT",
]);

function isNumericType(duckdbType: string): boolean {
  // Handle parameterized types like DECIMAL(18,2)
  const base = duckdbType.split("(")[0].toUpperCase();
  return NUMERIC_TYPES.has(base);
}

/** Frozen column widths (including the leading "#" column) + uniform row
 *  height, measured once per dataset so virtualization doesn't shift layout. */
interface GridMetrics {
  colWidths: number[];
  rowHeight: number;
}

export function DataGrid({
  columnNames,
  columnInfo,
  arrowFields,
  rows,
  startRow = 0,
  borderless,
  cellNavigation,
  canLoadMore,
  onLoadMore,
}: Props) {
  // Build maps for type lookups
  const infoByName = useMemo(() => {
    const map = new Map<string, ColumnInfo>();
    if (columnInfo) {
      for (const col of columnInfo) map.set(col.name, col);
    }
    return map;
  }, [columnInfo]);

  const fieldByName = useMemo(() => {
    const map = new Map<string, any>();
    if (arrowFields) {
      for (const f of arrowFields) map.set(f.name, f);
    }
    return map;
  }, [arrowFields]);

  const tableColumns = useMemo<ColumnDef<Record<string, any>>[]>(
    () =>
      columnNames.map((col) => {
        const info = infoByName.get(col);
        const numeric = info ? isNumericType(info.duckdbType) : false;
        const isGeometry = info?.duckdbType === "GEOMETRY";
        return {
          accessorKey: col,
          header: () => (
            <span className={numeric ? "text-right block" : ""}>{col}</span>
          ),
          cell: ({ getValue, column, row }) => {
            const val = getValue();
            if (isNullValue(val)) {
              return <span className={`text-muted-foreground/30 italic ${numeric ? "text-right block" : ""}`}>NULL</span>;
            }
            // Geometry: render clickable map viewer
            if (isGeometry && val instanceof Uint8Array) {
              const rowIdx = startRow + row.index + 1;
              return <GeometryViewer wkb={val} label={`Row ${rowIdx}`} />;
            }
            const field = fieldByName.get(column.id);
            const display = formatCellValue(val, column.id, field, info?.duckdbType);
            return <span className={`font-mono ${numeric ? "text-right block tabular-nums" : ""}`}>{display}</span>;
          },
        };
      }),
    [columnNames, infoByName]
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });
  const modelRows = table.getRowModel().rows;

  const scrollRef = useRef<HTMLDivElement>(null);
  const numCols = columnNames.length;

  // --- Layout freezing ------------------------------------------------------
  // Without virtualization the table auto-sizes columns from ALL rows; with it,
  // only the visible rows would set widths and columns would jump as you
  // scroll. So on the first render of a dataset we let the table lay out
  // naturally, snapshot the column widths + a row height, then switch to a
  // fixed <colgroup> layout and virtualize. `metrics === null` means
  // "measuring pass" (render rows un-virtualized so the snapshot is accurate).
  const [metrics, setMetrics] = useState<GridMetrics | null>(null);

  // Re-measure whenever the column set changes (new table/result, pager jump).
  // Appends keep the same columns, so the frozen layout persists across them.
  useLayoutEffect(() => { setMetrics(null); }, [columnNames]);

  useLayoutEffect(() => {
    if (metrics || rows.length === 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const headRow = container.querySelector("thead tr");
    const bodyRow = container.querySelector("tbody tr");
    if (!headRow || !bodyRow) return;
    const colWidths = Array.from(headRow.children).map((c) => (c as HTMLElement).getBoundingClientRect().width);
    const rowHeight = (bodyRow as HTMLElement).getBoundingClientRect().height || 25;
    if (colWidths.length) setMetrics({ colWidths, rowHeight });
  }, [metrics, rows.length, columnNames]);

  const totalWidth = useMemo(
    () => (metrics ? metrics.colWidths.reduce((a, b) => a + b, 0) : 0),
    [metrics]
  );

  // --- Virtualization -------------------------------------------------------
  // Renders only the rows in (and near) the viewport, so DOM size and the cost
  // of each append stay constant no matter how many rows are loaded. The
  // sticky <thead> lives inside the scroll container; because it's sticky its
  // layout height is naturally absorbed, so no scrollMargin is needed — row N
  // sits just below the header at scrollTop = N * rowHeight.
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => metrics?.rowHeight ?? 25,
    overscan: 12,
  });
  // Re-measure the virtualizer when the frozen row height becomes known.
  useEffect(() => { rowVirtualizer.measure(); }, [metrics?.rowHeight, rowVirtualizer]);

  const virtualItems = metrics ? rowVirtualizer.getVirtualItems() : [];
  const paddingTop = virtualItems.length ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length
    ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0;

  // --- Keyboard cell navigation --------------------------------------------
  // The active cell is identified by its (row index within the loaded window,
  // data-column index). The scroll container is the focus + keydown target.
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  // Set when an arrow-Down at the last loaded row triggers an infinite-scroll
  // load: once the appended rows arrive, advance the cursor onto the first new
  // row. (Wheel-driven loads don't set this, so the cursor stays put.)
  const pendingAdvanceRef = useRef(false);
  const autoFocusedRef = useRef(false);
  // Classify a `rows` change as a window reset (startRow moved — pager jump /
  // new dataset) vs. an append (same startRow, more rows — infinite scroll).
  const prevStartRowRef = useRef(startRow);
  const prevLenRef = useRef(rows.length);

  useEffect(() => {
    if (!cellNavigation) return;
    const prevStart = prevStartRowRef.current;
    const prevLen = prevLenRef.current;
    prevStartRowRef.current = startRow;
    prevLenRef.current = rows.length;
    if (startRow !== prevStart) {
      // Window reset (pager jump, page-size change, new table/result).
      pendingAdvanceRef.current = false;
      setActive(null);
    } else if (rows.length > prevLen && pendingAdvanceRef.current) {
      // Infinite-scroll append driven by arrow-Down: step onto the first
      // newly-loaded row (prevLen is its index).
      pendingAdvanceRef.current = false;
      setActive((prev) => ({ row: prevLen, col: prev ? prev.col : 0 }));
      scrollRef.current?.focus({ preventScroll: true });
    }
  }, [rows, startRow, cellNavigation]);

  // Infinite scroll: load the next chunk as the user nears the bottom.
  const maybeLoadMore = useCallback(() => {
    const c = scrollRef.current;
    if (!c || !canLoadMore || !onLoadMore) return;
    if (c.scrollHeight - (c.scrollTop + c.clientHeight) < 200) onLoadMore();
  }, [canLoadMore, onLoadMore]);

  // Keep the active cell scrolled into view, accounting for the sticky header
  // (scrollIntoView would otherwise tuck the row under it). When the target row
  // isn't currently rendered (virtualized away), fall back to the virtualizer.
  useEffect(() => {
    if (!active) return;
    const container = scrollRef.current;
    if (!container) return;
    const cell = container.querySelector<HTMLElement>(`td[data-row="${active.row}"][data-col="${active.col}"]`);
    if (!cell) {
      rowVirtualizer.scrollToIndex(active.row, { align: "auto" });
      return;
    }
    const headerH = container.querySelector<HTMLElement>("thead")?.offsetHeight ?? 0;
    const cellTop = cell.offsetTop;
    const cellBottom = cellTop + cell.offsetHeight;
    if (cellTop - headerH < container.scrollTop) {
      container.scrollTop = cellTop - headerH;
    } else if (cellBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = cellBottom - container.clientHeight;
    }
    const cellLeft = cell.offsetLeft;
    const cellRight = cellLeft + cell.offsetWidth;
    if (cellLeft < container.scrollLeft) {
      container.scrollLeft = cellLeft;
    } else if (cellRight > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = cellRight - container.clientWidth;
    }
  }, [active, rowVirtualizer]);

  // Focus the grid once on first data load so arrow keys work without a click
  // — but never steal focus from an input/textarea (e.g. the shell terminal).
  useEffect(() => {
    if (!cellNavigation || autoFocusedRef.current || rows.length === 0) return;
    const ae = document.activeElement;
    const tag = ae?.tagName;
    if (!ae || ae === document.body || tag === "DIV") {
      scrollRef.current?.focus({ preventScroll: true });
      autoFocusedRef.current = true;
    }
  }, [cellNavigation, rows.length]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!cellNavigation || numCols === 0) return;
    const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (!navKeys.includes(e.key)) return;
    e.preventDefault();
    if (!active) { setActive({ row: 0, col: 0 }); return; }
    switch (e.key) {
      case "ArrowLeft":
        setActive({ row: active.row, col: Math.max(0, active.col - 1) });
        break;
      case "ArrowRight":
        setActive({ row: active.row, col: Math.min(numCols - 1, active.col + 1) });
        break;
      case "Home":
        setActive({ row: active.row, col: 0 });
        break;
      case "End":
        setActive({ row: active.row, col: numCols - 1 });
        break;
      case "ArrowUp":
        // Top of the loaded window — stop. (Infinite scroll only grows down;
        // use the footer's Prev to jump to an earlier page.)
        if (active.row > 0) setActive({ row: active.row - 1, col: active.col });
        break;
      case "ArrowDown":
        if (active.row < rows.length - 1) {
          setActive({ row: active.row + 1, col: active.col });
        } else if (canLoadMore && onLoadMore) {
          // At the last loaded row: pull the next chunk and advance onto it.
          pendingAdvanceRef.current = true;
          onLoadMore();
        }
        break;
    }
  }, [cellNavigation, numCols, active, rows.length, canLoadMore, onLoadMore]);

  // Sticky background applied per-<th> (not the <thead>) so the header pins
  // reliably across browsers and the cell backgrounds fully cover scrolled
  // rows underneath. The bottom border lives on the cells for the same reason.
  // The background must be fully OPAQUE or scrolled rows bleed through the
  // pinned header — so the green tint is composited over the (opaque) card
  // color via color-mix (inline style, theme-aware) rather than a translucent
  // primary/10.
  const headBg = borderless ? "border-b border-primary/20" : "bg-muted/90 backdrop-blur-sm border-b";
  const headStyle = borderless
    ? { backgroundColor: "color-mix(in oklab, var(--color-primary) 12%, var(--color-card))" }
    : undefined;

  const renderRow = (row: Row<Record<string, any>>, index: number) => (
    <TableRow
      key={row.id}
      className={`hover:bg-accent/5 ${index % 2 === 1 ? "bg-muted/15" : ""}`}
      style={metrics ? { height: metrics.rowHeight } : undefined}
    >
      <TableCell className="text-xs text-muted-foreground/40 text-right pr-3 font-mono py-1 w-10">
        {startRow + index + 1}
      </TableCell>
      {row.getVisibleCells().map((cell, ci) => {
        const isActive = cellNavigation && active?.row === index && active?.col === ci;
        return (
          <TableCell
            key={cell.id}
            {...(cellNavigation ? { "data-row": index, "data-col": ci } : {})}
            onClick={cellNavigation ? () => { setActive({ row: index, col: ci }); scrollRef.current?.focus({ preventScroll: true }); } : undefined}
            className={`text-xs py-1 whitespace-nowrap max-w-[400px] truncate ${cellNavigation ? "cursor-default" : ""} ${isActive ? "ring-2 ring-inset ring-primary bg-primary/10" : ""}`}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      })}
    </TableRow>
  );

  return (
    <Table
      containerRef={scrollRef}
      containerClassName={`${borderless ? "h-full overflow-auto" : "border rounded-md max-h-full overflow-auto"}${cellNavigation ? " focus:outline-none" : ""}`}
      containerProps={cellNavigation ? { tabIndex: 0, onKeyDown: handleKeyDown, onScroll: maybeLoadMore, role: "grid", "aria-label": "Data preview" } : undefined}
      style={metrics ? { tableLayout: "fixed", width: totalWidth, minWidth: "100%" } : undefined}
    >
      {metrics && (
        <colgroup>
          {metrics.colWidths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
      )}
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className={borderless ? "border-none" : ""}>
            <TableHead style={headStyle} className={`sticky top-0 z-10 text-xs w-10 text-right pr-3 font-mono ${headBg} ${borderless ? "text-primary/60" : "text-muted-foreground"}`}>#</TableHead>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id} style={headStyle} className={`sticky top-0 z-10 text-xs font-mono whitespace-nowrap ${headBg} ${borderless ? "text-primary/80 font-semibold" : ""}`}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {metrics ? (
          <>
            {paddingTop > 0 && (
              <tr aria-hidden="true"><td colSpan={numCols + 1} style={{ height: paddingTop, padding: 0, border: 0 }} /></tr>
            )}
            {virtualItems.map((vi) => renderRow(modelRows[vi.index], vi.index))}
            {paddingBottom > 0 && (
              <tr aria-hidden="true"><td colSpan={numCols + 1} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>
            )}
          </>
        ) : (
          // Measuring pass: render rows un-virtualized so the snapshot reflects
          // real content widths. Only ever one chunk's worth of rows here.
          modelRows.map((row) => renderRow(row, row.index))
        )}
      </TableBody>
    </Table>
  );
}
