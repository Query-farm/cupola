import { formatCellValue } from "@/lib/format";
import type { ColumnInfo } from "@/lib/service";

/** The full display text of one cell, formatted exactly as the grid formats it
 *  (the grid only truncates it visually). */
export function cellText(
  value: any,
  column: string,
  field: any,
  info: ColumnInfo | undefined,
  numberGrouping?: boolean,
): string {
  return formatCellValue(value, column, field, info?.duckdbType, { grouping: numberGrouping });
}

/** Indented JSON when `text` is a JSON object or array, else null. Only objects
 *  and arrays: re-printing a bare JSON number or string would change nothing,
 *  and would round large integers through a double. */
export function prettyJson(text: string): string | null {
  const t = text.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}
