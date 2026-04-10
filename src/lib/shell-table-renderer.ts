/**
 * Terminal table rendering for DuckDB query results.
 * Box-mode (cli-table3) and line-mode output matching DuckDB CLI style.
 */
import { formatCellValue, safeGetArrowValue } from "@/lib/format";

/** Minimal terminal output interface needed by the renderers. */
export interface TerminalOutput {
  /** Current terminal width in columns. */
  cols: number;
  /** Print a line to the terminal (with implicit newline). */
  println: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Format a value for display, returning "NULL" for null/undefined. */
function formatVal(val: any, field: any): string {
  if (val === null || val === undefined) return "NULL";
  return formatCellValue(val, field?.name, field);
}

/** Truncate a string to maxLen, appending … if needed. */
export function truncStr(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/** Check if an Arrow field represents a numeric type. */
export function isNumericField(field: any): boolean {
  const t = field.type?.toString() || "";
  return /^(Int|Uint|Float|Decimal|float|int|uint|double)/i.test(t) ||
    t.startsWith("Duration");
}

/** Map Arrow field to a short DuckDB type name for the type row. */
export function fieldToDuckDBType(field: any): string {
  const t = field.type?.toString() || "?";
  const map: Record<string, string> = {
    "Utf8": "varchar", "LargeUtf8": "varchar",
    "Int8": "tinyint", "Int16": "smallint", "Int32": "int32", "Int64": "int64",
    "Uint8": "utinyint", "Uint16": "usmallint", "Uint32": "uint32", "Uint64": "uint64",
    "Float16": "float", "Float32": "float", "Float64": "double",
    "Bool": "boolean", "Binary": "blob", "LargeBinary": "blob",
  };
  if (map[t]) return map[t];
  if (t.startsWith("Dictionary<")) {
    const inner = t.match(/,\s*(.+)>$/)?.[1];
    return inner && map[inner] ? map[inner] : "varchar";
  }
  if (t.startsWith("Timestamp")) return "timestamp";
  if (t.startsWith("Date")) return "date";
  if (t.startsWith("Time")) return "time";
  if (t.startsWith("Decimal")) return "decimal";
  if (t.startsWith("Struct")) return "struct";
  if (t.includes("List")) return "list";
  const ext = field.metadata?.get?.("ARROW:extension:name");
  if (ext?.startsWith("geoarrow.")) return "geometry";
  return t.toLowerCase();
}

/** Format a row/column/time footer string. */
function formatFooter(numRows: number, displayRows: number, truncated: boolean, totalCols: number, shownCols: number, elapsedMs?: number): string {
  const rowText = truncated
    ? `${numRows} row${numRows !== 1 ? "s" : ""} (${displayRows} shown)`
    : `${numRows} row${numRows !== 1 ? "s" : ""}`;
  const colText = shownCols < totalCols
    ? `${totalCols} columns (${shownCols} shown)`
    : `${totalCols} column${totalCols !== 1 ? "s" : ""}`;
  const timeText = elapsedMs != null
    ? (elapsedMs < 1000 ? `${Math.round(elapsedMs)}ms` : `${(elapsedMs / 1000).toFixed(2)}s`)
    : "";
  return `\x1b[2m${[rowText, totalCols > 1 ? colText : "", timeText].filter(Boolean).join("    ")}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

/** Build the display indices (head + tail with gap) for a result set. */
function getDisplayIndices(numRows: number, maxDisplayRows: number): { indices: number[]; truncated: boolean; half: number } {
  const half = Math.floor(maxDisplayRows / 2);
  const truncated = numRows > maxDisplayRows;
  const indices: number[] = [];
  if (!truncated) {
    for (let r = 0; r < numRows; r++) indices.push(r);
  } else {
    for (let r = 0; r < half; r++) indices.push(r);
    for (let r = numRows - half; r < numRows; r++) indices.push(r);
  }
  return { indices, truncated, half };
}

/** Extract a formatted string grid from an Arrow table for the given row indices. */
function buildGrid(table: any, fields: any[], displayIndices: number[]): string[][] {
  const totalCols = fields.length;
  const grid: string[][] = [];
  for (const r of displayIndices) {
    const row: string[] = [];
    for (let c = 0; c < totalCols; c++) {
      row.push(formatVal(safeGetArrowValue(table.getChildAt(c), r, fields[c]), fields[c]));
    }
    grid.push(row);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Box-mode rendering (cli-table3)
// ---------------------------------------------------------------------------

const MAX_COL_WIDTH = 20;

/** Compute ideal column widths (capped at MAX_COL_WIDTH). */
function computeIdealWidths(names: string[], types: string[], grid: string[][], totalCols: number): number[] {
  const widths: number[] = [];
  for (let c = 0; c < totalCols; c++) {
    let w = Math.max(names[c].length, types[c].length);
    for (const row of grid) w = Math.max(w, row[c].length);
    widths.push(Math.min(w, MAX_COL_WIDTH));
  }
  return widths;
}

/** Determine which columns are visible given terminal width, pruning from the middle. */
function pruneColumns(idealWidths: number[], termW: number): { visibleIndices: number[]; ellipsisPos: number | null } {
  const calcTotal = (widths: number[]) => 1 + widths.reduce((s, w) => s + w + 3, 0);
  const totalCols = idealWidths.length;

  if (calcTotal(idealWidths) <= termW) {
    return { visibleIndices: idealWidths.map((_, i) => i), ellipsisPos: null };
  }

  const ELLIPSIS_COST = 4;
  const hidden = new Set<number>();
  const mid = Math.floor(totalCols / 2);
  const order: number[] = [mid];
  for (let d = 1; d < totalCols; d++) {
    if (mid - d >= 0) order.push(mid - d);
    if (mid + d < totalCols) order.push(mid + d);
  }
  for (const idx of order) {
    hidden.add(idx);
    const remaining = idealWidths.filter((_, i) => !hidden.has(i));
    if (calcTotal(remaining) + ELLIPSIS_COST <= termW) break;
  }

  const visibleIndices: number[] = [];
  let ellipsisPos: number | null = null;
  let insertedEllipsis = false;
  for (let i = 0; i < totalCols; i++) {
    if (hidden.has(i)) {
      if (!insertedEllipsis) {
        ellipsisPos = visibleIndices.length;
        insertedEllipsis = true;
      }
    } else {
      visibleIndices.push(i);
    }
  }
  if (hidden.size > 0 && ellipsisPos === null) {
    ellipsisPos = visibleIndices.length;
  }
  return { visibleIndices, ellipsisPos };
}

/** Distribute leftover terminal width to columns that were capped. */
function distributeSlack(
  idealWidths: number[], visibleIndices: number[], ellipsisPos: number | null,
  termW: number, names: string[], grid: string[][]
): void {
  const ellipsisCost = ellipsisPos != null ? 4 : 0;
  const usedWidth = 1 + ellipsisCost + visibleIndices.reduce((s, ci) => s + idealWidths[ci] + 3, 0);
  let slack = termW - usedWidth;
  if (slack <= 0) return;

  const naturalWidths = visibleIndices.map(ci => {
    let w = Math.max(names[ci].length);
    for (const row of grid) w = Math.max(w, row[ci].length);
    return w;
  });
  const expandable = visibleIndices
    .map((ci, vi) => naturalWidths[vi] > idealWidths[ci] ? vi : -1)
    .filter(i => i >= 0);

  while (slack > 0 && expandable.length > 0) {
    const share = Math.max(1, Math.floor(slack / expandable.length));
    let expanded = false;
    for (let i = expandable.length - 1; i >= 0; i--) {
      const vi = expandable[i];
      const ci = visibleIndices[vi];
      const need = naturalWidths[vi] - idealWidths[ci];
      if (need <= 0) { expandable.splice(i, 1); continue; }
      const give = Math.min(need, share, slack);
      idealWidths[ci] += give;
      slack -= give;
      expanded = true;
      if (idealWidths[ci] >= naturalWidths[vi]) expandable.splice(i, 1);
      if (slack <= 0) break;
    }
    if (!expanded) break;
  }
}

/**
 * Render an Arrow table in DuckDB box-drawing style using cli-table3.
 * Falls back to pipe-separated output if cli-table3 fails to load.
 */
export async function printBoxTable(table: any, out: TerminalOutput, maxDisplayRows: number, elapsedMs?: number): Promise<void> {
  const fields = table.schema.fields;
  const numRows = table.numRows;
  const totalCols = fields.length;
  if (totalCols === 0) { out.println("(empty)"); return; }

  const { indices, truncated, half } = getDisplayIndices(numRows, maxDisplayRows);
  const grid = buildGrid(table, fields, indices);
  const displayRows = indices.length;

  const names: string[] = fields.map((f: any) => f.name);
  const types: string[] = fields.map((f: any) => fieldToDuckDBType(f));
  const isNumeric: boolean[] = fields.map((f: any) => isNumericField(f));
  const idealWidths = computeIdealWidths(names, types, grid, totalCols);

  const { visibleIndices, ellipsisPos } = pruneColumns(idealWidths, out.cols);
  const shownCount = visibleIndices.length;
  const hiddenCount = totalCols - shownCount;

  distributeSlack(idealWidths, visibleIndices, ellipsisPos, out.cols, names, grid);

  try {
    const Table = (await import(/* @vite-ignore */ "cli-table3")).default;

    const colWidths: number[] = [];
    const colAligns: ("left" | "right" | "center")[] = [];
    const headerRow: any[] = [];
    const typeRow: any[] = [];

    for (let vi = 0; vi < shownCount; vi++) {
      if (ellipsisPos === vi) {
        colWidths.push(3);
        colAligns.push("center");
        headerRow.push({ content: "…", hAlign: "center" as const });
        typeRow.push({ content: " ", hAlign: "center" as const });
      }
      const ci = visibleIndices[vi];
      colWidths.push(idealWidths[ci] + 2);
      colAligns.push(isNumeric[ci] ? "right" : "left");
      headerRow.push({ content: `\x1b[1m${truncStr(names[ci], idealWidths[ci])}\x1b[0m`, hAlign: "center" as const });
      typeRow.push({ content: `\x1b[90m${truncStr(types[ci], idealWidths[ci])}\x1b[0m`, hAlign: "center" as const });
    }
    if (ellipsisPos === shownCount) {
      colWidths.push(3);
      colAligns.push("center");
      headerRow.push({ content: "…", hAlign: "center" as const });
      typeRow.push({ content: " ", hAlign: "center" as const });
    }

    const tableOpts = {
      colWidths,
      colAligns,
      chars: { "mid": "", "left-mid": "", "mid-mid": "", "right-mid": "" },
      style: { head: [], border: [], "padding-left": 1, "padding-right": 1, compact: true },
    };

    // Header table
    const hdrBottomChars = displayRows === 0
      ? { "bottom": "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘" }
      : { "bottom": "─", "bottom-mid": "┼", "bottom-left": "├", "bottom-right": "┤" };
    const hdrTbl = new Table({ ...tableOpts, chars: { ...tableOpts.chars, ...hdrBottomChars } });
    hdrTbl.push(headerRow);
    hdrTbl.push(typeRow);
    for (const line of hdrTbl.toString().split("\n")) out.println(line);

    // Data table
    const dataTbl = new Table({
      ...tableOpts,
      chars: { ...tableOpts.chars, "top": "", "top-mid": "", "top-left": "", "top-right": "" },
    });
    for (let r = 0; r < displayRows; r++) {
      if (truncated && r === half) {
        for (let g = 0; g < 3; g++) {
          const gapRow: any[] = [];
          for (let vi = 0; vi < shownCount; vi++) {
            if (ellipsisPos === vi) gapRow.push({ content: "·", hAlign: "center" as const });
            gapRow.push({ content: "·", hAlign: "center" as const });
          }
          if (ellipsisPos === shownCount) gapRow.push({ content: "·", hAlign: "center" as const });
          dataTbl.push(gapRow);
        }
      }
      const row: any[] = [];
      for (let vi = 0; vi < shownCount; vi++) {
        if (ellipsisPos === vi) row.push({ content: "…", hAlign: "center" as const });
        const ci = visibleIndices[vi];
        const val = grid[r][ci];
        const display = val === "NULL" ? `\x1b[2mNULL\x1b[0m` : truncStr(val, idealWidths[ci]);
        row.push(isNumeric[ci] ? { content: display, hAlign: "right" as const } : display);
      }
      if (ellipsisPos === shownCount) row.push({ content: "…", hAlign: "center" as const });
      dataTbl.push(row);
    }
    for (const line of dataTbl.toString().split("\n")) out.println(line);

    out.println(formatFooter(numRows, displayRows, truncated, totalCols, shownCount, elapsedMs));
  } catch {
    // Fallback: simple pipe-separated
    for (const row of grid) out.println(row.join(" | "));
    out.println(`(${numRows} row${numRows !== 1 ? "s" : ""})`);
  }
}

/**
 * Render an Arrow table in line mode — one field per line, vertically.
 */
export function printLineTable(table: any, out: TerminalOutput, maxDisplayRows: number, elapsedMs?: number): void {
  const fields = table.schema.fields;
  const numRows = table.numRows;
  const totalCols = fields.length;
  if (totalCols === 0) { out.println("(empty)"); return; }

  const { indices, truncated, half } = getDisplayIndices(numRows, maxDisplayRows);
  const names: string[] = fields.map((f: any) => f.name);
  const maxNameLen = Math.max(...names.map((n: string) => n.length));
  const lineWidth = Math.min(out.cols, maxNameLen + 30);

  for (let i = 0; i < indices.length; i++) {
    if (truncated && i === half) {
      const gapLabel = ` · · · ${numRows - maxDisplayRows} records omitted · · · `;
      const gapDashes = Math.max(0, lineWidth - gapLabel.length - 1);
      out.println(`\x1b[2m─${gapLabel}${"─".repeat(gapDashes)}\x1b[0m`);
    }
    const r = indices[i];
    const label = ` RECORD ${r + 1} `;
    const dashCount = Math.max(0, lineWidth - label.length - 1);
    out.println(`\x1b[2m─${label}${"─".repeat(dashCount)}\x1b[0m`);
    for (let c = 0; c < totalCols; c++) {
      const val = formatVal(safeGetArrowValue(table.getChildAt(c), r, fields[c]), fields[c]);
      const name = names[c].padStart(maxNameLen);
      const display = val === "NULL" ? `\x1b[2mNULL\x1b[0m` : val;
      out.println(`${name} = ${display}`);
    }
  }

  out.println(formatFooter(numRows, indices.length, truncated, totalCols, totalCols, elapsedMs));
}
