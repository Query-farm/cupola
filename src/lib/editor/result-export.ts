/**
 * Export an in-memory Arrow `Table` (a query result) to CSV, Arrow IPC, or
 * Excel. All formats are generated client-side from the already-decoded table
 * — DuckDB's COPY TO can't be used because the AsyncDuckDB handle is private
 * to the worker-boot module.
 *
 * Cell values are pulled with the same `safeGetArrowValue` + `formatCellValue`
 * pipeline the grid uses, so exports match exactly what the user sees.
 */
import { tableToIPC } from "apache-arrow";
import { safeGetArrowValue, formatCellValue } from "@/lib/format";
import { arrowFieldToDuckDB } from "@/lib/arrow-to-duckdb";

export type ExportFormat = "csv" | "arrow" | "excel";

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Build a header row + formatted string cell matrix from the Arrow table. */
function toMatrix(table: any): { headers: string[]; rows: string[][] } {
  const fields = table.schema.fields;
  const headers = fields.map((f: any) => f.name);
  const duckTypes = fields.map((f: any) => arrowFieldToDuckDB(f));
  const rows: string[][] = [];
  for (let r = 0; r < table.numRows; r++) {
    const row: string[] = [];
    for (let c = 0; c < fields.length; c++) {
      const raw = safeGetArrowValue(table.getChildAt(c), r, fields[c]);
      if (raw === null || raw === undefined) {
        row.push("");
      } else {
        row.push(formatCellValue(raw, headers[c], fields[c], duckTypes[c]));
      }
    }
    rows.push(row);
  }
  return { headers, rows };
}

/** CSV string built in chunks to avoid one giant intermediate string. */
export function toCsv(table: any): Blob {
  const { headers, rows } = toMatrix(table);
  const parts: string[] = [headers.map(csvEscape).join(",") + "\n"];
  const CHUNK = 1000;
  let buf = "";
  for (let i = 0; i < rows.length; i++) {
    buf += rows[i].map(csvEscape).join(",") + "\n";
    if (i % CHUNK === CHUNK - 1) {
      parts.push(buf);
      buf = "";
    }
  }
  if (buf) parts.push(buf);
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

/** Arrow IPC file — exact fidelity, no coercion. */
export function toArrowIpc(table: any): Blob {
  const ipc = tableToIPC(table, "file");
  return new Blob([ipc as unknown as BlobPart], { type: "application/vnd.apache.arrow.file" });
}

/** Excel .xlsx via SheetJS. Cells are pre-formatted strings (SheetJS can't
 *  serialize BigInt or typed arrays). */
export async function toXlsx(table: any): Promise<Blob> {
  const XLSX = await import("xlsx");
  const { headers, rows } = toMatrix(table);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Result");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** Trigger a browser download for a blob. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Sanitize a tab name into a safe filename stem. */
export function safeFileStem(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "query-result";
}

/** Export the table in the given format and download it. */
export async function exportResult(table: any, format: ExportFormat, stem: string): Promise<void> {
  const base = safeFileStem(stem);
  if (format === "csv") {
    triggerDownload(toCsv(table), `${base}.csv`);
  } else if (format === "arrow") {
    triggerDownload(toArrowIpc(table), `${base}.arrow`);
  } else {
    triggerDownload(await toXlsx(table), `${base}.xlsx`);
  }
}
