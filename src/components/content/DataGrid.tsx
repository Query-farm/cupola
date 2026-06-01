import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
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

  // --- Keyboard cell navigation --------------------------------------------
  // The active cell is identified by its (row index within the current page,
  // data-column index). The scroll container is also the focus + keydown
  // target, so arrow keys only act when the grid is focused.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  // Set when an arrow-Down at the last loaded row triggers an infinite-scroll
  // load: once the appended rows arrive, advance the cursor onto the first new
  // row. (Wheel-driven loads don't set this, so the cursor stays put.)
  const pendingAdvanceRef = useRef(false);
  const autoFocusedRef = useRef(false);
  // Track the previous (startRow, length) to classify a `rows` change as a
  // window reset (startRow moved — pager jump / new dataset) vs. an append
  // (same startRow, more rows — infinite scroll).
  const prevStartRowRef = useRef(startRow);
  const prevLenRef = useRef(rows.length);
  const numCols = columnNames.length;

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
    if (c.scrollHeight - (c.scrollTop + c.clientHeight) < 120) onLoadMore();
  }, [canLoadMore, onLoadMore]);

  // Keep the active cell scrolled into view, accounting for the sticky header
  // (scrollIntoView would otherwise tuck the row under it).
  useEffect(() => {
    if (!active) return;
    const container = scrollRef.current;
    if (!container) return;
    const cell = container.querySelector<HTMLElement>(`td[data-row="${active.row}"][data-col="${active.col}"]`);
    if (!cell) return;
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
  }, [active]);

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
  const headBg = borderless
    ? "bg-primary/10 border-b border-primary/20"
    : "bg-muted/90 backdrop-blur-sm border-b";

  return (
    <Table
      containerRef={scrollRef}
      containerClassName={`${borderless ? "h-full overflow-auto" : "border rounded-md max-h-full overflow-auto"}${cellNavigation ? " focus:outline-none" : ""}`}
      containerProps={cellNavigation ? { tabIndex: 0, onKeyDown: handleKeyDown, onScroll: maybeLoadMore, role: "grid", "aria-label": "Data preview" } : undefined}
    >
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className={borderless ? "border-none" : ""}>
            <TableHead className={`sticky top-0 z-10 text-xs w-10 text-right pr-3 font-mono ${headBg} ${borderless ? "text-primary/60" : "text-muted-foreground"}`}>#</TableHead>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id} className={`sticky top-0 z-10 text-xs font-mono whitespace-nowrap ${headBg} ${borderless ? "text-primary/80 font-semibold" : ""}`}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row, idx) => (
          <TableRow key={row.id} className="even:bg-muted/15 hover:bg-accent/5">
            <TableCell className="text-xs text-muted-foreground/40 text-right pr-3 font-mono py-1 w-10">
              {startRow + idx + 1}
            </TableCell>
            {row.getVisibleCells().map((cell, ci) => {
              const isActive = cellNavigation && active?.row === row.index && active?.col === ci;
              return (
                <TableCell
                  key={cell.id}
                  {...(cellNavigation ? { "data-row": row.index, "data-col": ci } : {})}
                  onClick={cellNavigation ? () => { setActive({ row: row.index, col: ci }); scrollRef.current?.focus({ preventScroll: true }); } : undefined}
                  className={`text-xs py-1 whitespace-nowrap max-w-[400px] truncate ${cellNavigation ? "cursor-default" : ""} ${isActive ? "ring-2 ring-inset ring-primary bg-primary/10" : ""}`}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
