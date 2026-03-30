/**
 * Value formatting for data grid display.
 * Handles DuckDB/Arrow types: dates, timestamps, geometry, binary, BigInt, etc.
 */

/** Format a cell value for display in the data grid. */
export function formatCellValue(value: any, columnName?: string): string {
  if (value === null || value === undefined) return "";

  // Binary / Uint8Array → geometry or binary indicator
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return "[binary]";
  }

  // BigInt — could be a date, timestamp, or actual integer
  if (typeof value === "bigint") {
    return formatBigInt(value, columnName);
  }

  // Number — could be a date epoch or timestamp
  if (typeof value === "number") {
    // Timestamp in milliseconds (1e12 range = 2001-2033)
    if (value > 1e11 && value < 3e12) {
      return formatTimestampMillis(value);
    }
    // Date32 values (days since epoch, 10000-100000 = 1997-2243)
    if (isDateColumnName(columnName) && value > 10000 && value < 100000) {
      return formatDate32(value);
    }
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  // Object — geometry, struct, etc.
  if (typeof value === "object" && value !== null) {
    if (value.type || value.coordinates) return "[geometry]";
    if (value instanceof Date) return value.toISOString().split("T")[0];
    try { return JSON.stringify(value); } catch { return "[object]"; }
  }

  // Boolean
  if (typeof value === "boolean") return value ? "true" : "false";

  // String
  return String(value);
}

/** Check if a column name suggests a date type. */
function isDateColumnName(name?: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower === "date" || lower.endsWith("_date") || lower.startsWith("date_")
    || lower === "created" || lower === "updated" || lower === "modified"
    || lower === "created_at" || lower === "updated_at";
}

/** Format a BigInt that might be a date or timestamp. */
function formatBigInt(value: bigint, columnName?: string): string {
  const num = Number(value);

  // Date32: days since epoch (typically 18000-25000 range for 2019-2038)
  if (isDateColumnName(columnName) && num > 10000 && num < 100000) {
    return formatDate32(num);
  }

  // Timestamp in microseconds (typical range: 1e15 to 2e15 for 2001-2033)
  if (num > 1e14 && num < 3e15) {
    return formatTimestampMicros(num);
  }

  // Timestamp in milliseconds (typical range: 1e12 to 2e12)
  if (num > 1e11 && num < 3e12) {
    return formatTimestampMillis(num);
  }

  // Regular integer
  if (num >= Number.MIN_SAFE_INTEGER && num <= Number.MAX_SAFE_INTEGER) {
    return num.toLocaleString();
  }
  return value.toString();
}

/** Format Date32 (days since epoch) to YYYY-MM-DD. */
function formatDate32(days: number): string {
  const ms = days * 86400000;
  const d = new Date(ms);
  return d.toISOString().split("T")[0];
}

/** Format timestamp in microseconds to ISO string. */
function formatTimestampMicros(micros: number): string {
  const d = new Date(micros / 1000);
  return d.toISOString().replace("T", " ").replace("Z", "").replace(/\.000$/, "");
}

/** Format timestamp in milliseconds to ISO string. */
function formatTimestampMillis(millis: number): string {
  const d = new Date(millis);
  return d.toISOString().replace("T", " ").replace("Z", "").replace(/\.000$/, "");
}

/** Check if a value is null/undefined. */
export function isNullValue(value: any): boolean {
  return value === null || value === undefined;
}
