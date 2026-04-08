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

    // Decimal: Arrow returns raw Uint32Array bytes — convert to number using scale
    if (typeStr.startsWith("Decimal") && field.type?.scale != null) {
      const scale = field.type.scale as number;
      const raw = decimalToNumber(value);
      if (raw !== null) {
        const result = raw / Math.pow(10, scale);
        return result.toLocaleString(undefined, {
          minimumFractionDigits: scale,
          maximumFractionDigits: scale,
        });
      }
    }

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

    // Decimal: parse scale from DECIMAL(p,s) and format accordingly
    if (baseType === "DECIMAL") {
      const scaleMatch = duckdbType.match(/,\s*(\d+)\)/);
      const scale = scaleMatch ? parseInt(scaleMatch[1], 10) : 2;
      if (typeof num === "number" && !isNaN(num)) {
        return num.toLocaleString(undefined, {
          minimumFractionDigits: scale,
          maximumFractionDigits: scale,
        });
      }
    }

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

/**
 * Convert an Arrow Decimal value (Uint32Array of 128-bit integer) to a JS number.
 * Also handles cases where the value is already a number or bigint.
 */
function decimalToNumber(value: any): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);

  // Arrow Decimal128: Uint32Array with 4 uint32 words (little-endian 128-bit signed integer)
  if (value instanceof Uint32Array && value.length >= 2) {
    // For values that fit in 64 bits (most practical decimals), use the low 64 bits
    const lo = value[0];
    const hi = value[1];
    // Check sign from the highest word
    const signWord = value[value.length - 1];
    const negative = (signWord & 0x80000000) !== 0;

    if (negative) {
      // Two's complement: invert all bits, add 1
      const words = Array.from(value);
      let carry = 1;
      for (let i = 0; i < words.length; i++) {
        const inverted = (~words[i] >>> 0) + carry;
        words[i] = inverted >>> 0;
        carry = inverted > 0xFFFFFFFF ? 1 : 0;
      }
      const mag = words[0] + words[1] * 0x100000000;
      return -mag;
    }

    return lo + hi * 0x100000000;
  }

  return null;
}

/** Check if a value is null/undefined. */
export function isNullValue(value: any): boolean {
  return value === null || value === undefined;
}

/** Format a number with SI abbreviation: 42, 1.2K, 350K, 2.1M, 1.5B */
export function formatCompactNumber(n: number): string {
  if (n < 0) return String(n);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${+k.toFixed(1)}K`;
  }
  if (n < 1_000_000_000) {
    const m = n / 1_000_000;
    return m >= 100 ? `${Math.round(m)}M` : `${+m.toFixed(1)}M`;
  }
  const b = n / 1_000_000_000;
  return b >= 100 ? `${Math.round(b)}B` : `${+b.toFixed(1)}B`;
}

const NUMERIC_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
  "FLOAT", "DOUBLE", "REAL",
]);

/** Format a min..max range for compact display in the stats column. */
export function formatStatRange(min: any, max: any, columnType: string): string {
  if (min == null && max == null) return "";
  const baseType = columnType.split("(")[0].toUpperCase().trim();

  // Date types
  if (DATE_TYPES.has(baseType)) {
    const fmt = (v: any) => {
      if (v == null) return "?";
      const s = String(v);
      // Already formatted as YYYY-MM-DD or ISO
      if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
      return s;
    };
    return `${fmt(min)}..${fmt(max)}`;
  }

  // Numeric types
  if (NUMERIC_TYPES.has(baseType) || baseType.startsWith("DECIMAL")) {
    const fmt = (v: any) => {
      if (v == null) return "?";
      const n = typeof v === "bigint" ? Number(v) : Number(v);
      if (isNaN(n)) return String(v);
      if (Number.isInteger(n)) return n.toLocaleString();
      return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    };
    return `${fmt(min)}..${fmt(max)}`;
  }

  // Geometry: BOX(...) strings
  if (baseType === "GEOMETRY") {
    return "[bbox]";
  }

  // Timestamp types
  if (TIMESTAMP_TYPES.has(baseType)) {
    const fmt = (v: any) => {
      if (v == null) return "?";
      return String(v).slice(0, 16); // YYYY-MM-DD HH:MM
    };
    return `${fmt(min)}..${fmt(max)}`;
  }

  // All other types (VARCHAR, BLOB, TEXT, ENUM, etc.) — DuckDB truncates
  // string stats to 8 bytes, so min/max values are misleading. Skip them.
  return "";
}
