/**
 * Build clipboard payloads (TSV + HTML) from a rectangular selection of the
 * data grid, and write them to the system clipboard.
 *
 * Values are rendered through `formatCellValue` so what lands on the clipboard
 * matches exactly what the grid displays (including WKT for geometry columns).
 */

import { formatCellValue } from "./format";
import type { ColumnInfo } from "./service";

/** Inclusive rectangle of grid coordinates (row/col indices into the loaded window). */
export interface CellRect {
  rowMin: number;
  rowMax: number;
  colMin: number;
  colMax: number;
}

export interface GridClipboard {
  /** Tab-separated values, newline between rows. Pastes into spreadsheets + plain text. */
  text: string;
  /** An HTML <table> so rich targets (Sheets, docs) receive a real table. */
  html: string;
}

/** A TSV field needs quoting when it contains a tab, newline, CR, or a double quote.
 *  Excel/Sheets accept CSV-style quoting inside TSV: wrap in `"`, double internal `"`. */
function tsvEscape(value: string): string {
  if (/[\t\n\r"]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Escape a value for inclusion in HTML text content. */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build TSV + HTML representations of the given rectangle.
 *
 * @param rows        The loaded row window (each a name→value record).
 * @param columnNames Ordered column names, indexed by grid column.
 * @param fieldByName Arrow field per column name (for type-aware formatting).
 * @param infoByName  Column metadata per column name (supplies the DuckDB type).
 * @param rect        Inclusive selection rectangle.
 */
export function buildGridClipboard(
  rows: Record<string, any>[],
  columnNames: string[],
  fieldByName: Map<string, any>,
  infoByName: Map<string, ColumnInfo>,
  rect: CellRect,
): GridClipboard {
  const rowMin = Math.max(0, rect.rowMin);
  const rowMax = Math.min(rows.length - 1, rect.rowMax);
  const colMin = Math.max(0, rect.colMin);
  const colMax = Math.min(columnNames.length - 1, rect.colMax);

  const tsvRows: string[] = [];
  const htmlRows: string[] = [];

  for (let r = rowMin; r <= rowMax; r++) {
    const row = rows[r] ?? {};
    const tsvCells: string[] = [];
    const htmlCells: string[] = [];
    for (let c = colMin; c <= colMax; c++) {
      const name = columnNames[c];
      const val = row[name];
      const text =
        val === null || val === undefined
          ? ""
          : formatCellValue(val, name, fieldByName.get(name), infoByName.get(name)?.duckdbType);
      tsvCells.push(tsvEscape(text));
      htmlCells.push(`<td>${htmlEscape(text)}</td>`);
    }
    tsvRows.push(tsvCells.join("\t"));
    htmlRows.push(`<tr>${htmlCells.join("")}</tr>`);
  }

  return {
    text: tsvRows.join("\n"),
    html: `<table>${htmlRows.join("")}</table>`,
  };
}

/**
 * Write both representations to the clipboard. Prefers the rich
 * `ClipboardItem` API (text/plain + text/html); falls back to plain-text TSV
 * when `ClipboardItem` is unavailable. Must be called from a user gesture.
 */
export async function writeGridClipboard(payload: GridClipboard): Promise<void> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        "text/plain": new Blob([payload.text], { type: "text/plain" }),
        "text/html": new Blob([payload.html], { type: "text/html" }),
      });
      await navigator.clipboard.write([item]);
      return;
    }
  } catch {
    // Fall through to the plain-text path (some browsers reject text/html items).
  }
  await navigator.clipboard?.writeText(payload.text);
}
