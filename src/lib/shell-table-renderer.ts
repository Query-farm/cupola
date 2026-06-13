/**
 * Terminal table rendering for DuckDB query results.
 * Box-mode (cli-table3) and line-mode output matching DuckDB CLI style.
 */
import type { Table, Field } from "apache-arrow";
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

/** Escape control characters the way DuckDB's duckbox does: newlines/tabs/CR
 *  become visible \n / \t / \r so a value is always one logical line and can't
 *  break the box border, and any other control char (incl. ESC) is rendered as
 *  \xNN so cell data can't inject ANSI escapes into the terminal. */
function escapeControl(s: string): string {
  return s
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) =>
      "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"),
    );
}

/** Format a value for display, returning "NULL" for null/undefined. */
function formatVal(val: unknown, field: Field): string {
  if (val === null || val === undefined) return "NULL";
  return escapeControl(formatCellValue(val, field?.name, field));
}

/**
 * Per-codepoint terminal display width, mirroring `string-width` (which
 * cli-table3 uses to lay out the box) and used as xterm's width provider too,
 * so column sizing, the box border, and the rendered glyphs all agree. Wide
 * ranges follow `is-fullwidth-code-point`; emoji ranges cover the common
 * blocks. Variation selectors / combining marks are 0, so base-emoji (2) +
 * VS16 (0) totals 2. NOTE: JS String.length counts UTF-16 units and is wrong
 * here (a supplementary emoji is len 2, a BMP wide char len 1) — always use
 * displayWidth() for column math.
 */
export function cellWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1 controls
  if (
    (cp >= 0x300 && cp <= 0x36f) ||   // combining marks
    (cp >= 0x200b && cp <= 0x200f) || // zero-width spaces, ZWJ, marks
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors (incl. VS16)
    cp === 0xfeff
  ) return 0;
  const wide =
    cp === 0x3000 ||
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  const emoji =
    cp === 0x2122 || cp === 0x2139 || cp === 0x2764 ||
    (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols + dingbats
    (cp >= 0x2b00 && cp <= 0x2bff) || // misc symbols & arrows (⬜ etc.)
    (cp >= 0x1f000 && cp <= 0x1faff); // supplementary emoji
  return wide || emoji ? 2 : 1;
}

/** Terminal display width of a string (sum of cellWidth over code points). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cellWidth(ch.codePointAt(0) as number);
  return w;
}

/** Truncate to a display width of maxLen, appending … if needed. */
export function truncStr(s: string, maxLen: number): string {
  if (displayWidth(s) <= maxLen) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = cellWidth(ch.codePointAt(0) as number);
    if (w + cw > maxLen - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** Check if an Arrow field represents a numeric type. */
export function isNumericField(field: Field): boolean {
  const t = field.type?.toString() || "";
  return /^(Int|Uint|Float|Decimal|float|int|uint|double)/i.test(t) ||
    t.startsWith("Duration");
}

/** Map Arrow field to a short DuckDB type name for the type row. */
export function fieldToDuckDBType(field: Field): string {
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
function buildGrid(table: Table, fields: Field[], displayIndices: number[]): string[][] {
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
    let w = Math.max(displayWidth(names[c]), displayWidth(types[c]));
    for (const row of grid) w = Math.max(w, displayWidth(row[c]));
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
    let w = displayWidth(names[ci]);
    for (const row of grid) w = Math.max(w, displayWidth(row[ci]));
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
export async function printBoxTable(table: Table, out: TerminalOutput, maxDisplayRows: number, elapsedMs?: number): Promise<void> {
  const fields = table.schema.fields;
  const numRows = table.numRows;
  const totalCols = fields.length;
  if (totalCols === 0) { out.println("(empty)"); return; }

  const { indices, truncated, half } = getDisplayIndices(numRows, maxDisplayRows);
  const grid = buildGrid(table, fields, indices);
  const displayRows = indices.length;

  const names = fields.map((f) => f.name);
  const types = fields.map((f) => fieldToDuckDBType(f));
  const isNumeric = fields.map((f) => isNumericField(f));
  const idealWidths = computeIdealWidths(names, types, grid, totalCols);

  const { visibleIndices, ellipsisPos } = pruneColumns(idealWidths, out.cols);
  const shownCount = visibleIndices.length;
  const hiddenCount = totalCols - shownCount;

  distributeSlack(idealWidths, visibleIndices, ellipsisPos, out.cols, names, grid);

  try {
    const Table = (await import(/* @vite-ignore */ "cli-table3")).default;

    type CellContent = string | { content: string; hAlign: "left" | "right" | "center" };
    const colWidths: number[] = [];
    const colAligns: ("left" | "right" | "center")[] = [];
    const headerRow: CellContent[] = [];
    const typeRow: CellContent[] = [];

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
      // Wrap long cell values across lines (DuckDB duckbox style) instead of
      // truncating with an ellipsis. wrapOnWordBoundary:false lets it break
      // inside long tokens like JSON blobs that have no spaces.
      wordWrap: true,
      wrapOnWordBoundary: false,
      chars: { "mid": "", "left-mid": "", "mid-mid": "", "right-mid": "" },
      style: { head: [], border: [], "padding-left": 1, "padding-right": 1, compact: true },
    };

    // Header table. wordWrap is disabled here: header/type cells carry ANSI
    // styling (bold/gray), and cli-table3's word-wrap counts those escape
    // characters toward the width and breaks mid-sequence — mangling short
    // headers like "host". They're already sized to fit, so no wrap is needed.
    const hdrBottomChars = displayRows === 0
      ? { "bottom": "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘" }
      : { "bottom": "─", "bottom-mid": "┼", "bottom-left": "├", "bottom-right": "┤" };
    const hdrTbl = new Table({ ...tableOpts, wordWrap: false, chars: { ...tableOpts.chars, ...hdrBottomChars } });
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
          const gapRow: CellContent[] = [];
          for (let vi = 0; vi < shownCount; vi++) {
            if (ellipsisPos === vi) gapRow.push({ content: "·", hAlign: "center" as const });
            gapRow.push({ content: "·", hAlign: "center" as const });
          }
          if (ellipsisPos === shownCount) gapRow.push({ content: "·", hAlign: "center" as const });
          dataTbl.push(gapRow);
        }
      }
      const row: CellContent[] = [];
      for (let vi = 0; vi < shownCount; vi++) {
        if (ellipsisPos === vi) row.push({ content: "…", hAlign: "center" as const });
        const ci = visibleIndices[vi];
        const val = grid[r][ci];
        // No manual truncation: cli-table3 wordWrap renders the full value
        // across as many lines as the column width needs (duckbox style).
        const display = val === "NULL" ? `\x1b[2mNULL\x1b[0m` : val;
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
export function printLineTable(table: Table, out: TerminalOutput, maxDisplayRows: number, elapsedMs?: number): void {
  const fields = table.schema.fields;
  const numRows = table.numRows;
  const totalCols = fields.length;
  if (totalCols === 0) { out.println("(empty)"); return; }

  const { indices, truncated, half } = getDisplayIndices(numRows, maxDisplayRows);
  const names = fields.map((f) => f.name);
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
