/**
 * Value formatting for data grid and terminal display.
 * Handles DuckDB/Arrow types: dates, timestamps, time, geometry, binary, BigInt, etc.
 *
 * Formatting is ONLY based on explicit type information (Arrow field or DuckDB type string).
 * No heuristic guessing from value ranges — integers stay as integers.
 */

const DATE_TYPES = new Set(["DATE", "DATE32", "DATE64"]);
const TIMESTAMP_TYPES = new Set(["TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_US", "TIMESTAMP_NS", "TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ", "DATETIME"]);
const TIME_TYPES = new Set(["TIME", "TIME WITH TIME ZONE", "TIMETZ"]);

/**
 * Format a cell value for display.
 *
 * Uses Arrow field type or DuckDB type string for formatting decisions.
 * Never guesses type from value ranges.
 */
export function formatCellValue(value: any, columnName?: string, field?: any, duckdbType?: string): string {
  if (value === null || value === undefined) return "";

  // Binary / Uint8Array → geometry or binary indicator
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return "[binary]";
  }

  // Arrow field — precise type dispatch
  if (field) {
    const typeStr: string = field.type?.toString() || "";
    const num = typeof value === "bigint" ? Number(value) : value;
    if (typeof num === "number" && !isNaN(num)) {
      if (typeStr.startsWith("Date")) {
        const d = new Date(num);
        if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
      }
      if (typeStr.startsWith("Timestamp")) {
        const d = new Date(num);
        if (!isNaN(d.getTime())) return formatTimestampMillis(d.getTime());
      }
      if (typeStr.startsWith("Time")) {
        return formatTime(num);
      }
    }
  }

  // DuckDB type string — precise type dispatch
  if (duckdbType) {
    const baseType = duckdbType.split("(")[0].toUpperCase().trim();
    const num = typeof value === "bigint" ? Number(value) : value;
    if (typeof num === "number" && !isNaN(num)) {
      if (DATE_TYPES.has(baseType)) {
        // Date32: days since epoch → YYYY-MM-DD
        const d = new Date(num * 86400000);
        if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
      }
      if (TIMESTAMP_TYPES.has(baseType)) {
        // Timestamps from DuckDB arrive as microseconds via BigInt, or millis via number
        if (typeof value === "bigint") {
          return formatTimestampMicros(Number(value));
        }
        const d = new Date(num);
        if (!isNaN(d.getTime())) return formatTimestampMillis(num);
      }
      if (TIME_TYPES.has(baseType)) {
        return formatTime(num);
      }
      if (baseType === "INTERVAL") {
        return formatInterval(value);
      }
    }
  }

  // BigInt → plain integer string
  if (typeof value === "bigint") {
    const num = Number(value);
    if (num >= Number.MIN_SAFE_INTEGER && num <= Number.MAX_SAFE_INTEGER) {
      return num.toLocaleString();
    }
    return value.toString();
  }

  // Number — format as number (no date guessing)
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  // Object — geometry, struct, Date, etc.
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

/** Format timestamp in microseconds to ISO-like string. */
function formatTimestampMicros(micros: number): string {
  const d = new Date(micros / 1000);
  return d.toISOString().replace("T", " ").replace("Z", "").replace(/\.000$/, "");
}

/** Format timestamp in milliseconds to ISO-like string. */
function formatTimestampMillis(millis: number): string {
  const d = new Date(millis);
  return d.toISOString().replace("T", " ").replace("Z", "").replace(/\.000$/, "");
}

/** Format time value (milliseconds since midnight) to HH:MM:SS. */
function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Format an interval value. */
function formatInterval(value: any): string {
  if (typeof value === "object" && value !== null) {
    try { return JSON.stringify(value); } catch {}
  }
  return String(value);
}

/** Check if a value is null/undefined. */
export function isNullValue(value: any): boolean {
  return value === null || value === undefined;
}
