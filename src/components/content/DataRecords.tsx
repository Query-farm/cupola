import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isNullValue } from "@/lib/format";
import type { ColumnInfo } from "@/lib/service";
import { GeometryViewer } from "./GeometryViewer";
import { cellText } from "./cell-text";

/** Values longer than this are cut until the reader asks for the rest, so one
 *  multi-megabyte cell can't stall layout of the whole list. */
const VALUE_PREVIEW_CHARS = 10_000;

interface Props {
  columnNames: string[];
  columnInfo?: ColumnInfo[];
  arrowFields?: any[];
  rows: Record<string, any>[];
  startRow?: number;
  canLoadMore?: boolean;
  onLoadMore?: () => void;
  geometryAsText?: boolean;
  numberGrouping?: boolean;
}

/**
 * Line-by-line results, like DuckDB's `.mode line`: one block per row, one
 * `column  value` line per column, with every value shown in full and wrapped.
 * The alternative to DataGrid for results whose values don't fit a column.
 *
 * Rows have variable height, so the virtualizer measures each rendered record.
 * Infinite scroll appends below, the same contract as DataGrid's.
 */
export function DataRecords({
  columnNames,
  columnInfo,
  arrowFields,
  rows,
  startRow = 0,
  canLoadMore,
  onLoadMore,
  geometryAsText,
  numberGrouping,
}: Props) {
  const infoByName = useMemo(
    () => new Map((columnInfo ?? []).map((c) => [c.name, c])),
    [columnInfo],
  );
  const fieldByName = useMemo(
    () => new Map((arrowFields ?? []).map((f: any) => [f.name, f])),
    [arrowFields],
  );
  // Labels are padded to the longest column name, in ch, so values line up.
  const labelWidth = useMemo(
    () => Math.min(32, Math.max(4, ...columnNames.map((c) => c.length))),
    [columnNames],
  );
  // Long values the reader expanded, keyed `row:column`. Held here, not in the
  // record, so it survives a record being virtualized away and back.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28 + columnNames.length * 20,
    overscan: 4,
  });

  const maybeLoadMore = useCallback(() => {
    const c = scrollRef.current;
    if (!c || !canLoadMore || !onLoadMore) return;
    if (c.scrollHeight - (c.scrollTop + c.clientHeight) < 400) onLoadMore();
  }, [canLoadMore, onLoadMore]);

  const renderValue = (rowIndex: number, col: string) => {
    const val = rows[rowIndex][col];
    if (isNullValue(val)) return <span className="text-muted-foreground/40 italic">NULL</span>;
    const info = infoByName.get(col);
    if (info?.duckdbType === "GEOMETRY" && val instanceof Uint8Array && !geometryAsText) {
      return <GeometryViewer wkb={val} label={`Row ${startRow + rowIndex + 1}`} />;
    }
    const text = cellText(val, col, fieldByName.get(col), info, numberGrouping);
    const key = `${rowIndex}:${col}`;
    if (text.length <= VALUE_PREVIEW_CHARS || expanded.has(key)) return text;
    return (
      <>
        {text.slice(0, VALUE_PREVIEW_CHARS)}
        <button
          type="button"
          className="ml-1 text-accent hover:underline cursor-pointer font-sans"
          onClick={() => setExpanded((s) => new Set(s).add(key))}
        >
          … show all {text.length.toLocaleString()} characters
        </button>
      </>
    );
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      onScroll={maybeLoadMore}
      className="h-full overflow-auto"
      role="list"
      aria-label="Result rows"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            role="listitem"
            className="absolute left-0 right-0 px-4 py-1.5 border-b border-border"
            style={{ transform: `translateY(${vi.start}px)` }}
          >
            <div className="text-[11px] font-mono text-primary/70 font-semibold mb-0.5">
              Row {(startRow + vi.index + 1).toLocaleString()}
            </div>
            <dl
              className="grid gap-x-3 text-xs font-mono"
              style={{ gridTemplateColumns: `minmax(0, ${labelWidth}ch) minmax(0, 1fr)` }}
            >
              {columnNames.map((col) => (
                <div key={col} className="contents">
                  <dt
                    className="text-muted-foreground text-right truncate"
                    title={infoByName.get(col)?.duckdbType ? `${col} (${infoByName.get(col)!.duckdbType})` : col}
                  >
                    {col}
                  </dt>
                  <dd className="whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
                    {renderValue(vi.index, col)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
