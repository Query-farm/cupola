import { useCallback, useMemo, useRef, useState } from "react";
import { Braces } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isNullValue } from "@/lib/format";
import type { ColumnInfo } from "@/lib/service";
import { GeometryViewer } from "./GeometryViewer";
import { cellText, prettyJson } from "./cell-text";

/** Values longer than this are cut until the reader asks for the rest, so one
 *  multi-megabyte cell can't stall layout of the whole list. */
const VALUE_PREVIEW_CHARS = 10_000;

interface Props {
  columnNames: string[];
  columnInfo?: ColumnInfo[];
  arrowFields?: any[];
  rows: Record<string, any>[];
  startRow?: number;
  /** Rows in the whole result, for the "Row 3 of 1,200" header. */
  totalRows?: number | null;
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
  totalRows,
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
  // The label gutter fits the longest column name (in ch, plus padding), capped
  // so a long name can't squeeze the values; longer names truncate.
  const labelWidth = useMemo(
    () => Math.min(28, Math.max(6, ...columnNames.map((c) => c.length))),
    [columnNames],
  );
  // Long values the reader expanded, keyed `row:column`. Held here, not in the
  // record, so it survives a record being virtualized away and back.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // JSON values the reader switched back to the stored text (formatted is the default).
  const [raw, setRaw] = useState<Set<string>>(() => new Set());
  const toggleIn = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44 + columnNames.length * 25,
    overscan: 4,
  });

  const maybeLoadMore = useCallback(() => {
    const c = scrollRef.current;
    if (!c || !canLoadMore || !onLoadMore) return;
    if (c.scrollHeight - (c.scrollTop + c.clientHeight) < 400) onLoadMore();
  }, [canLoadMore, onLoadMore]);

  const renderValue = (rowIndex: number, col: string) => {
    const val = rows[rowIndex][col];
    if (isNullValue(val)) return <span className="text-muted-foreground/50 italic">NULL</span>;
    const info = infoByName.get(col);
    if (info?.duckdbType === "GEOMETRY" && val instanceof Uint8Array && !geometryAsText) {
      return <GeometryViewer wkb={val} label={`Row ${startRow + rowIndex + 1}`} />;
    }
    const stored = cellText(val, col, fieldByName.get(col), info, numberGrouping);
    const key = `${rowIndex}:${col}`;
    const pretty = prettyJson(stored);
    const showRaw = raw.has(key);
    const text = pretty && !showRaw ? pretty : stored;
    const jsonToggle = pretty && (
      <button
        type="button"
        onClick={() => setRaw((s) => toggleIn(s, key))}
        aria-pressed={!showRaw}
        aria-label={showRaw ? "Format JSON" : "Show as stored"}
        title={showRaw ? "Format JSON" : "Show as stored"}
        className={`absolute right-1.5 top-1 inline-flex h-5 w-5 items-center justify-center rounded
          cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity
          ${showRaw ? "text-muted-foreground hover:bg-muted" : "bg-primary/10 text-primary"}`}
      >
        <Braces className="h-3 w-3" />
      </button>
    );
    if (text.length <= VALUE_PREVIEW_CHARS || expanded.has(key)) return <>{text}{jsonToggle}</>;
    return (
      <>
        {text.slice(0, VALUE_PREVIEW_CHARS)}
        <button
          type="button"
          className="ml-1 rounded px-1 text-accent hover:bg-accent/10 cursor-pointer font-sans text-[11px]"
          onClick={() => setExpanded((s) => new Set(s).add(key))}
        >
          … show all {text.length.toLocaleString()} characters
        </button>
        {jsonToggle}
      </>
    );
  };

  const items = virtualizer.getVirtualItems();
  // Same opaque tint as DataGrid's header, so the two layouts read as one.
  const headStyle = { backgroundColor: "color-mix(in oklab, var(--color-primary) 12%, var(--color-card))" };

  return (
    <div
      ref={scrollRef}
      onScroll={maybeLoadMore}
      className="h-full overflow-auto bg-muted/40"
      role="list"
      aria-label="Result rows"
    >
      {/* +12px: the gap below the last record (each record pads only its top). */}
      <div style={{ height: virtualizer.getTotalSize() + 12, position: "relative" }}>
        {items.map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            role="listitem"
            // Padding, not margin: the virtualizer measures the element's own box.
            className="absolute left-0 right-0 px-3 pt-3"
            // `top`, not a translateY transform: sticky positioning ignores
            // transforms, so every record's header would stick as if its record
            // started at the top of the list.
            style={{ top: vi.start }}
          >
            <article className="rounded-md border border-border bg-card shadow-xs">
              {/* Sticky within its record: a tall record keeps its row number in view. */}
              <header
                className="sticky top-0 z-10 flex items-baseline gap-1.5 rounded-t-md border-b border-primary/20 px-3 py-1.5 font-mono text-xs"
                style={headStyle}
              >
                <span className="font-semibold text-primary">Row {(startRow + vi.index + 1).toLocaleString()}</span>
                {totalRows != null && (
                  <span className="text-primary/50">of {totalRows.toLocaleString()}</span>
                )}
              </header>
              <dl className="divide-y divide-border text-xs font-mono">
                {columnNames.map((col) => {
                  const type = infoByName.get(col)?.duckdbType;
                  return (
                    <div
                      key={col}
                      className="grid hover:bg-accent/5 last:rounded-b-md"
                      // ch + the label's px-3 padding + its 1px rule.
                      style={{ gridTemplateColumns: `calc(${labelWidth}ch + 1.5rem + 1px) minmax(0, 1fr)` }}
                    >
                      <dt
                        className="truncate border-r border-border bg-muted/30 px-3 py-1 text-muted-foreground"
                        title={type ? `${col} · ${type}` : col}
                      >
                        {col}
                      </dt>
                      <dd className="group relative min-w-0 px-3 py-1 pr-8 whitespace-pre-wrap [overflow-wrap:anywhere] select-text tabular-nums">
                        {renderValue(vi.index, col)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </article>
          </div>
        ))}
      </div>
    </div>
  );
}
