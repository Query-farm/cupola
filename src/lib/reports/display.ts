import type { Table } from "@query-farm/apache-arrow";
import { formatCellValue, safeGetArrowValue } from "@/lib/format";

/**
 * Build display-only report rows through the same Arrow-aware formatter used
 * by the shell, data grid, exports, and AI result serialization. Keeping the
 * Arrow field is important: plain report rows contain epoch numbers for
 * timestamps and otherwise lose the information needed to format them.
 */
export function reportDisplayRows(table: Table, columns: string[], limit: number): Record<string, any>[] {
  const fields = new Map(table.schema.fields.map((field) => [field.name, field]));
  const rowCount = Math.min(table.numRows, limit);
  const rows: Record<string, any>[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row: Record<string, any> = {};
    for (const columnName of columns) {
      const field = fields.get(columnName);
      const raw = safeGetArrowValue(table.getChild(columnName), rowIndex, field);
      row[columnName] = raw === null || raw === undefined ? null : formatCellValue(raw, columnName, field);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Format map attributes (including DECIMAL coordinates) through the standard
 * display path while keeping a binary geometry column intact for WKB parsing.
 */
export function reportMapRows(table: Table, geometryColumn?: string): Record<string, any>[] {
  const columns = table.schema.fields.map((field) => field.name);
  const rows = reportDisplayRows(table, columns, table.numRows);
  if (!geometryColumn) return rows;

  const geometry = table.getChild(geometryColumn);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    rows[rowIndex][geometryColumn] = geometry?.get(rowIndex) ?? null;
  }
  return rows;
}
