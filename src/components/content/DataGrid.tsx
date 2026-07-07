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
import { ChevronUp, ChevronDown } from "lucide-react";
import { formatCellValue, isNullValue } from "@/lib/format";
import { buildGridClipboard, writeGridClipboard, type CellRect } from "@/lib/grid-clipboard";
import type { ColumnInfo } from "@/lib/service";
import { GeometryViewer } from "./GeometryViewer";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type SortState = { col: string; dir: "asc" | "desc" } | null;

/** A grid cell coordinate: row index within the loaded window + data-column index. */
type Cell = { row: number; col: number };
/** A rectangular selection: `anchor` is fixed, `focus` moves (the active cell). */
type Selection = { anchor: Cell; focus: Cell };

/** Inclusive min/max rectangle spanned by a selection's anchor and focus. */
function rectOf(sel: Selection): CellRect {
  return {
    rowMin: Math.min(sel.anchor.row, sel.focus.row),
    rowMax: Math.max(sel.anchor.row, sel.focus.row),
    colMin: Math.min(sel.anchor.col, sel.focus.col),
    colMax: Math.max(sel.anchor.col, sel.focus.col),
  };
}

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
  /** Render geometry columns as WKT text instead of the clickable map viewer. */
  geometryAsText?: boolean;
  /** Active column sort (rendered as a chevron on the header). */
  sort?: SortState;
  /** Called when a column header is clicked. Absent → headers aren't sortable. */
  onSort?: (col: string) => void;
}

/** A column header: hover shows the column comment (when present), click cycles
 *  the sort (or, with a modifier held, selects the whole column via `onHeaderClick`).
 *  Falls back to a plain label when the grid isn't sortable. */
function HeaderCell({
  col,
  numeric,
  comment,
  sortDir,
  onSort,
  onHeaderClick,
}: {
  col: string;
  numeric: boolean;
  comment?: string;
  sortDir: "asc" | "desc" | null;
  onSort?: (col: string) => void;
  /** Receives the raw click; a modifier+click here selects the column instead of sorting. */
  onHeaderClick?: (e: React.MouseEvent) => void;
}) {
  const chevron =
    sortDir === "asc" ? <ChevronUp className="h-3 w-3 shrink-0" /> :
    sortDir === "desc" ? <ChevronDown className="h-3 w-3 shrink-0" /> : null;
  const inner = (
    <>
      <span className="truncate">{col}</span>
      {chevron}
    </>
  );
  const layout = `flex items-center gap-1 max-w-full ${numeric ? "flex-row-reverse" : ""}`;

  // A modifier+click selects the whole column (onHeaderClick); a plain click sorts.
  const handleClick = (e: React.MouseEvent) => {
    if (onHeaderClick && (e.altKey || e.metaKey || e.ctrlKey)) {
      onHeaderClick(e);
      return;
    }
    onSort?.(col);
  };

  if (!onSort && !onHeaderClick) {
    // Not interactive: plain label, optionally with a hover tooltip for the comment.
    const label = <span className={numeric ? "text-right block" : ""}>{col}</span>;
    if (!comment) return label;
    return (
      <Tooltip>
        <TooltipTrigger className="cursor-default">{label}</TooltipTrigger>
        <TooltipContent>{comment}</TooltipContent>
      </Tooltip>
    );
  }

  const btnClass = `${layout} cursor-pointer hover:text-accent transition-colors`;
  if (!comment) {
    return (
      <button type="button" onClick={handleClick} className={btnClass}>
        {inner}
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger onClick={handleClick} className={btnClass}>
        {inner}
      </TooltipTrigger>
      <TooltipContent>{comment}</TooltipContent>
    </Tooltip>
  );
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
  geometryAsText,
  sort,
  onSort,
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
            // Geometry: render clickable map viewer, unless the user prefers
            // the WKT text representation (handled by formatCellValue below).
            if (isGeometry && val instanceof Uint8Array && !geometryAsText) {
              const rowIdx = startRow + row.index + 1;
              return <GeometryViewer wkb={val} label={`Row ${rowIdx}`} />;
            }
            const field = fieldByName.get(column.id);
            const display = formatCellValue(val, column.id, field, info?.duckdbType);
            return <span className={`font-mono ${numeric ? "text-right block tabular-nums" : ""}`}>{display}</span>;
          },
        };
      }),
    [columnNames, infoByName, fieldByName, startRow, geometryAsText]
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

  // --- Selection & keyboard navigation -------------------------------------
  // A selection is an anchor + focus cell. The focus is the "active" cell that
  // moves with the arrow keys and is kept scrolled into view; the rectangle
  // between anchor and focus is highlighted and is what Cmd/Ctrl+C copies. A
  // single-cell selection has anchor === focus. Whole-column / select-all cover
  // the LOADED rows only — infinite scroll may not have fetched the whole result.
  // The scroll container is the focus + keydown target.
  const [selection, setSelection] = useState<Selection | null>(null);
  const active = selection?.focus ?? null;
  const selRect = selection ? rectOf(selection) : null;

  // Collapse the selection onto a single cell (plain click / plain arrow move).
  const selectCell = useCallback((cell: Cell) => setSelection({ anchor: cell, focus: cell }), []);
  // Keep the anchor, move the focus (shift+move / shift+click / drag).
  const extendTo = useCallback((focus: Cell) => {
    setSelection((prev) => (prev ? { anchor: prev.anchor, focus } : { anchor: focus, focus }));
  }, []);
  // Select an entire loaded row (all columns); shift keeps the anchor's row.
  const selectRow = useCallback((row: number, extend: boolean) => {
    setSelection((prev) => {
      const anchorRow = extend && prev ? prev.anchor.row : row;
      return { anchor: { row: anchorRow, col: 0 }, focus: { row, col: numCols - 1 } };
    });
  }, [numCols]);
  // Select an entire column across all loaded rows.
  const selectColumn = useCallback((col: number) => {
    setSelection({ anchor: { row: 0, col }, focus: { row: Math.max(0, rows.length - 1), col } });
  }, [rows.length]);
  // Select every loaded cell.
  const selectAll = useCallback(() => {
    setSelection({ anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, rows.length - 1), col: numCols - 1 } });
  }, [rows.length, numCols]);

  // Set when an arrow-Down at the last loaded row triggers an infinite-scroll
  // load: once the appended rows arrive, advance the cursor onto the first new
  // row. `extend` remembers whether Shift was held so we keep the anchor.
  // (Wheel-driven loads don't set this, so the cursor stays put.)
  const pendingAdvanceRef = useRef<{ extend: boolean } | null>(null);
  // True while a mouse drag-select is in progress (mousedown on a cell).
  const draggingRef = useRef(false);
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
      pendingAdvanceRef.current = null;
      setSelection(null);
    } else if (rows.length > prevLen && pendingAdvanceRef.current) {
      // Infinite-scroll append driven by arrow-Down: step onto the first
      // newly-loaded row (prevLen is its index), extending if Shift was held.
      const { extend } = pendingAdvanceRef.current;
      pendingAdvanceRef.current = null;
      setSelection((prev) => {
        const col = prev ? prev.focus.col : 0;
        const focus = { row: prevLen, col };
        return { anchor: extend && prev ? prev.anchor : focus, focus };
      });
      scrollRef.current?.focus({ preventScroll: true });
    }
  }, [rows, startRow, cellNavigation]);

  // End any drag-select when the mouse is released anywhere on the page.
  useEffect(() => {
    if (!cellNavigation) return;
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [cellNavigation]);

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

  // Copy the current selection rectangle to the clipboard (TSV + HTML table).
  const copySelection = useCallback(() => {
    if (!selection) return;
    void writeGridClipboard(
      buildGridClipboard(rows, columnNames, fieldByName, infoByName, rectOf(selection)),
    );
  }, [selection, rows, columnNames, fieldByName, infoByName]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!cellNavigation || numCols === 0) return;
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+C — copy the selection.
    if (mod && (e.key === "c" || e.key === "C")) {
      if (selection) { e.preventDefault(); copySelection(); }
      return;
    }
    // Cmd/Ctrl+A — select all loaded cells.
    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      selectAll();
      return;
    }
    const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (!navKeys.includes(e.key)) return;
    e.preventDefault();
    if (!active) { selectCell({ row: 0, col: 0 }); return; }
    // Shift keeps the anchor and extends; a plain move collapses the selection.
    const move = e.shiftKey ? extendTo : selectCell;
    switch (e.key) {
      case "ArrowLeft":
        move({ row: active.row, col: Math.max(0, active.col - 1) });
        break;
      case "ArrowRight":
        move({ row: active.row, col: Math.min(numCols - 1, active.col + 1) });
        break;
      case "Home":
        move({ row: active.row, col: 0 });
        break;
      case "End":
        move({ row: active.row, col: numCols - 1 });
        break;
      case "ArrowUp":
        // Top of the loaded window — stop. (Infinite scroll only grows down;
        // use the footer's Prev to jump to an earlier page.)
        if (active.row > 0) move({ row: active.row - 1, col: active.col });
        break;
      case "ArrowDown":
        if (active.row < rows.length - 1) {
          move({ row: active.row + 1, col: active.col });
        } else if (canLoadMore && onLoadMore) {
          // At the last loaded row: pull the next chunk and advance onto it.
          pendingAdvanceRef.current = { extend: e.shiftKey };
          onLoadMore();
        }
        break;
    }
  }, [cellNavigation, numCols, active, selection, rows.length, canLoadMore, onLoadMore, extendTo, selectCell, selectAll, copySelection]);

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
      <TableCell
        onMouseDown={cellNavigation ? (e) => { selectRow(index, e.shiftKey); scrollRef.current?.focus({ preventScroll: true }); } : undefined}
        title={cellNavigation ? "Select row" : undefined}
        className={`text-xs text-muted-foreground/40 text-right pr-3 font-mono py-1 w-10 ${cellNavigation ? "cursor-pointer select-none" : ""}`}
      >
        {startRow + index + 1}
      </TableCell>
      {row.getVisibleCells().map((cell, ci) => {
        const inSelection = cellNavigation && !!selRect &&
          index >= selRect.rowMin && index <= selRect.rowMax &&
          ci >= selRect.colMin && ci <= selRect.colMax;
        const isFocus = cellNavigation && active?.row === index && active?.col === ci;
        return (
          <TableCell
            key={cell.id}
            {...(cellNavigation ? { "data-row": index, "data-col": ci } : {})}
            onMouseDown={cellNavigation ? (e) => {
              const c = { row: index, col: ci };
              // Shift+click extends the range; a plain press starts a drag-select.
              if (e.shiftKey) { extendTo(c); }
              else { selectCell(c); draggingRef.current = true; }
              scrollRef.current?.focus({ preventScroll: true });
            } : undefined}
            onMouseEnter={cellNavigation ? () => { if (draggingRef.current) extendTo({ row: index, col: ci }); } : undefined}
            className={`text-xs py-1 whitespace-nowrap max-w-[400px] truncate ${cellNavigation ? "cursor-default select-none" : ""} ${inSelection ? "bg-primary/10" : ""} ${isFocus ? "ring-2 ring-inset ring-primary" : ""}`}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      })}
    </TableRow>
  );

  return (
    <TooltipProvider>
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
            <TableHead
              style={headStyle}
              onMouseDown={cellNavigation ? () => { selectAll(); scrollRef.current?.focus({ preventScroll: true }); } : undefined}
              title={cellNavigation ? "Select all" : undefined}
              className={`sticky top-0 z-10 text-xs w-10 text-right pr-3 font-mono ${headBg} ${cellNavigation ? "cursor-pointer select-none" : ""} ${borderless ? "text-primary/60" : "text-muted-foreground"}`}
            >#</TableHead>
            {headerGroup.headers.map((header, hi) => {
              const col = header.column.id;
              const info = infoByName.get(col);
              const numeric = info ? isNumericType(info.duckdbType) : false;
              const sortDir = sort?.col === col ? sort.dir : null;
              return (
                <TableHead key={header.id} style={headStyle} className={`sticky top-0 z-10 text-xs font-mono whitespace-nowrap ${headBg} ${borderless ? "text-primary/80 font-semibold" : ""}`}>
                  <HeaderCell
                    col={col}
                    numeric={numeric}
                    comment={info?.comment}
                    sortDir={sortDir}
                    onSort={onSort}
                    onHeaderClick={cellNavigation ? () => { selectColumn(hi); scrollRef.current?.focus({ preventScroll: true }); } : undefined}
                  />
                </TableHead>
              );
            })}
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
    </TooltipProvider>
  );
}
