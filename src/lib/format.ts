/**
 * Value formatting for data grid and terminal display.
 * Handles DuckDB/Arrow types: dates, timestamps, time, geometry, binary, BigInt, etc.
 *
 * Formatting matches DuckDB CLI output — no locale-specific formatting (no commas).
 * Uses pure arithmetic for dates/timestamps to support the full DuckDB range.
 */

/** Timezone name from DuckDB's TimeZone setting (e.g., "America/New_York").
 *  Set by the shell at init via setDuckDBTimezone(). Used for timestamp_tz display. */
let _duckdbTimezone: string | null = null;

/** Set the DuckDB timezone for timestamp_tz formatting. Call once at shell init. */
export function setDuckDBTimezone(tz: string): void {
  _duckdbTimezone = tz;
}

const DATE_TYPES = new Set(["DATE", "DATE32", "DATE64"]);
const TIMESTAMP_TYPES = new Set(["TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_US", "TIMESTAMP_NS", "TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ", "DATETIME"]);
const TIME_TYPES = new Set(["TIME", "TIME_NS", "TIME WITH TIME ZONE", "TIMETZ"]);

/**
 * Format a cell value for display.
 *
 * Uses Arrow field type or DuckDB type string for formatting decisions.
 * Output matches DuckDB CLI formatting — no locale commas.
 */
export function formatCellValue(value: any, columnName?: string, field?: any, duckdbType?: string): string {
  if (value === null || value === undefined) return "";

  // DuckDB Arrow extension types (arrow_lossless_conversion=true)
  // These come as FixedSizeBinary (Uint8Array) with ARROW:extension:metadata
  if (field && (value instanceof Uint8Array)) {
    const extTypeName = getDuckDBExtensionType(field);
    if (extTypeName === "hugeint") return formatFixedBinaryInt128(value, true);
    if (extTypeName === "uhugeint") return formatFixedBinaryInt128(value, false);
    if (extTypeName === "time_tz") return formatFixedBinaryTimeTz(value);
    if (extTypeName === "uuid" || field.metadata?.get?.("ARROW:extension:name") === "arrow.uuid") {
      return formatUUID(value);
    }
  }

  // Arrow bool8 extension: Int8 representing boolean (0=false, 1=true)
  if (field) {
    const extName = field.metadata?.get?.("ARROW:extension:name");
    if (extName === "arrow.bool8" && typeof value === "number") {
      return value !== 0 ? "true" : "false";
    }
  }

  // Tagged raw values from safeGet
  if (typeof value === "object" && value !== null) {
    if (value.__rawDays !== undefined) return formatDateFromDays(value.__rawDays);
    if (value.__int128 !== undefined) return (value.__int128 as bigint).toString();
    if (value.__uint128 !== undefined) return (value.__uint128 as bigint).toString();
    if (value.__decimal128 !== undefined) return formatDecimal(value.__decimal128, value.scale ?? 0);
    if (value.__uuid !== undefined) return formatUUID(value.__uuid);
    if (value.__interval !== undefined) return formatInterval(value.__interval);
    if (value.__timeTz !== undefined) {
      const { micros, offsetSecs } = value.__timeTz;
      const timeStr = formatTimeValue(micros, "us", false);
      const absOff = Math.abs(offsetSecs);
      const offH = Math.floor(absOff / 3600);
      const offM = Math.floor((absOff % 3600) / 60);
      const offS = absOff % 60;
      const offSign = offsetSecs >= 0 ? "+" : "-";
      let offStr = `${offSign}${String(offH).padStart(2, "0")}`;
      if (offM > 0 || offS > 0) offStr += `:${String(offM).padStart(2, "0")}`;
      if (offS > 0) offStr += `:${String(offS).padStart(2, "0")}`;
      return `${timeStr}${offStr}`;
    }
  }

  // Binary / Uint8Array → check for extension types first, then format as blob
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    if (field) {
      try {
        const extMeta = field.metadata?.get?.("ARROW:extension:metadata");
        if (extMeta) {
          const typeName = JSON.parse(extMeta)?.type_name;
          if (typeName === "bignum" || typeName === "varint") return formatBignum(bytes);
          if (typeName === "bit") return formatBitString(bytes);
        }
      } catch { /* ignore */ }
    }
    // BLOB: format as DuckDB hex string
    return formatBlob(bytes);
  }

  // Arrow field — precise type dispatch
  if (field) {
    const typeStr: string = field.type?.toString() || "";

    // Dictionary/Enum — Arrow wraps the value; extract the string
    if (typeStr.startsWith("Dictionary") || field.type?.dictionaryVector) {
      // Arrow dictionary .get() returns the resolved value
      if (typeof value === "number" || typeof value === "bigint") {
        // Value is the dictionary index — shouldn't happen after .get(), but handle it
        return String(value);
      }
      return String(value);
    }

    // Decimal128: Arrow returns Uint32Array — convert to BigInt for full precision
    if (typeStr.startsWith("Decimal") && field.type?.scale != null) {
      const scale = field.type.scale as number;
      const raw = decimalToBigInt(value);
      if (raw !== null) {
        return formatDecimal(raw, scale);
      }
    }

    // Float32 — limit to 8 significant digits to match DuckDB CLI display
    if (typeStr === "Float32" && typeof value === "number") {
      // DuckDB uses printf %g with 8 significant figures for FLOAT
      return Number(value.toPrecision(8)).toString();
    }

    // Timestamps — dispatch by precision from Arrow type
    if (typeStr.startsWith("Timestamp")) {
      const unit = getTimestampUnit(typeStr);
      const displayPrec = getTimestampDisplayPrecision(typeStr);
      const tz = field.type?.timezone || null;
      return formatTimestamp(value, unit, tz, displayPrec);
    }

    if (typeStr.startsWith("Date")) {
      // Value tagged as raw days (set by safeGet for Date32 columns to avoid precision loss)
      if (typeof value === "object" && value?.__rawDays !== undefined) {
        return formatDateFromDays(value.__rawDays);
      }
      // Arrow .get() returns milliseconds — convert back to days
      const num = toNumber(value);
      if (num !== null) return formatDateFromDays(Math.round(num / 86400000));
    }

    if (typeStr.startsWith("Time")) {
      const hasNs = typeStr.includes("NANOSECOND") || typeStr.includes("Nanosecond");
      return formatTimeValue(value, hasNs ? "ns" : "us", false);
    }

    // Interval
    if (typeStr.startsWith("Interval")) {
      return formatInterval(value);
    }

    // Int128 types (Hugeint, UHugeint) — Arrow gives us a Uint32Array
    if (typeStr === "Int128" || typeStr === "Uint128" ||
        typeStr.includes("Int64") && value instanceof Uint32Array) {
      return formatInt128(value, typeStr.startsWith("Uint") || typeStr === "Uint128");
    }
  }

  // DuckDB type string — precise type dispatch
  if (duckdbType) {
    const baseType = duckdbType.split("(")[0].toUpperCase().trim();

    // Decimal: parse scale from DECIMAL(p,s)
    if (baseType === "DECIMAL") {
      const scaleMatch = duckdbType.match(/,\s*(\d+)\)/);
      const scale = scaleMatch ? parseInt(scaleMatch[1], 10) : 2;
      const raw = decimalToBigInt(value);
      if (raw !== null) return formatDecimal(raw, scale);
      const num = toNumber(value);
      if (num !== null) return num.toFixed(scale);
    }

    // Timestamps — dispatch by DuckDB type for correct precision
    if (TIMESTAMP_TYPES.has(baseType)) {
      const unit = baseType === "TIMESTAMP_S" ? "s"
        : baseType === "TIMESTAMP_MS" ? "ms"
        : baseType === "TIMESTAMP_NS" ? "ns"
        : "us"; // TIMESTAMP, TIMESTAMP_US
      const hasTz = baseType.includes("TZ") || baseType.includes("TIME ZONE");
      return formatTimestamp(value, unit, hasTz ? "UTC" : null);
    }

    if (DATE_TYPES.has(baseType)) {
      const num = toNumber(value);
      if (num !== null) return formatDateFromDays(Math.floor(num / 86400000));
    }

    if (TIME_TYPES.has(baseType)) {
      const hasNs = baseType === "TIME_NS";
      const hasTz = baseType.includes("TZ") || baseType.includes("TIME ZONE");
      return formatTimeValue(value, hasNs ? "ns" : "us", hasTz);
    }

    if (baseType === "INTERVAL") {
      return formatInterval(value);
    }

    if (baseType === "HUGEINT") return formatInt128(value, false);
    if (baseType === "UHUGEINT") return formatInt128(value, true);
  }

  // BigInt → plain integer string (no commas, matching DuckDB CLI)
  if (typeof value === "bigint") {
    return value.toString();
  }

  // Number — format without locale commas
  if (typeof value === "number") {
    // Use scientific notation for extreme values (like DuckDB does for float/double)
    if (Number.isFinite(value) && !Number.isInteger(value)) {
      const abs = Math.abs(value);
      if (abs >= 1e15 || (abs > 0 && abs < 1e-4)) {
        return value.toString(); // JS toString() uses scientific notation for these ranges
      }
    }
    if (Number.isInteger(value)) return value.toString();
    return value.toString();
  }

  // Object — geometry, struct, arrays, Date, etc.
  if (typeof value === "object" && value !== null) {
    // GeoJSON geometry objects
    if (value.coordinates && typeof value.type === "string" &&
        ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"].includes(value.type)) {
      return "[geometry]";
    }
    if (value instanceof Date) return formatDateFromDays(Math.floor(value.getTime() / 86400000));
    // Arrow Vector objects with .toArray() — lists, maps, vectors
    if (typeof value.toArray === "function") {
      return formatArrowValue(value, field);
    }
    // Plain JS objects (including StructRow proxies) — format as DuckDB-style struct
    if (!Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Int32Array) &&
        !(value instanceof Float64Array) && !(value instanceof BigInt64Array)) {
      return formatPlainStruct(value);
    }
    try { return JSON.stringify(value); } catch { return "[object]"; }
  }

  // Boolean
  if (typeof value === "boolean") return value ? "true" : "false";

  // String
  return String(value);
}

// ============================================================================
// Number conversion helpers
// ============================================================================

/** Safely convert a value to a JS number, returning null if not possible or unsafe. */
function toNumber(value: any): number | null {
  if (typeof value === "number") return isNaN(value) ? null : value;
  if (typeof value === "bigint") {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return null;
  }
  return null;
}

// ============================================================================
// 128-bit integer formatting (Hugeint / UHugeint)
// ============================================================================

/** Format a 128-bit integer value. Arrow gives us Uint32Array with 4 words (little-endian). */
function formatInt128(value: any, unsigned: boolean): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return value.toString();

  // Uint32Array with 4 words (128-bit little-endian)
  if (value instanceof Uint32Array && value.length >= 4) {
    // Combine 4 x 32-bit words into a BigInt
    const w0 = BigInt(value[0]);
    const w1 = BigInt(value[1]);
    const w2 = BigInt(value[2]);
    const w3 = BigInt(value[3]);
    const raw = w0 | (w1 << BigInt(32)) | (w2 << BigInt(64)) | (w3 << BigInt(96));

    if (unsigned) {
      return raw.toString();
    }
    // Signed: check MSB
    const mask128 = (BigInt(1) << BigInt(128)) - BigInt(1);
    const signBit = BigInt(1) << BigInt(127);
    if (raw & signBit) {
      // Negative: two's complement
      const magnitude = ((raw ^ mask128) + BigInt(1)) & mask128;
      return "-" + magnitude.toString();
    }
    return raw.toString();
  }

  // Fallback: 2 words (64-bit)
  if (value instanceof Uint32Array && value.length >= 2) {
    const lo = BigInt(value[0]);
    const hi = BigInt(value[1]);
    const raw = lo | (hi << BigInt(32));
    return raw.toString();
  }

  return String(value);
}

// ============================================================================
// Decimal formatting (128-bit with scale)
// ============================================================================

/** Convert an Arrow Decimal128 value to BigInt for full precision. */
function decimalToBigInt(value: any): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.round(value));

  // Arrow Decimal128: Uint32Array with 4 uint32 words (little-endian 128-bit signed integer)
  if (value instanceof Uint32Array && value.length >= 4) {
    const w0 = BigInt(value[0]);
    const w1 = BigInt(value[1]);
    const w2 = BigInt(value[2]);
    const w3 = BigInt(value[3]);
    const raw = w0 | (w1 << BigInt(32)) | (w2 << BigInt(64)) | (w3 << BigInt(96));

    const signBit = BigInt(1) << BigInt(127);
    const mask128 = (BigInt(1) << BigInt(128)) - BigInt(1);
    if (raw & signBit) {
      return -((raw ^ mask128) + BigInt(1) & mask128);
    }
    return raw;
  }

  // 2-word fallback
  if (value instanceof Uint32Array && value.length >= 2) {
    const lo = BigInt(value[0]);
    const hi = BigInt(value[1]);
    const signBit = BigInt(1) << BigInt(63);
    const raw = lo | (hi << BigInt(32));
    if (raw & signBit) {
      const mask64 = (BigInt(1) << BigInt(64)) - BigInt(1);
      return -((raw ^ mask64) + BigInt(1) & mask64);
    }
    return raw;
  }

  return null;
}

/** Format a decimal value from a BigInt unscaled value and a scale. */
function formatDecimal(unscaled: bigint, scale: number): string {
  if (scale === 0) return unscaled.toString();

  const negative = unscaled < BigInt(0);
  const abs = negative ? -unscaled : unscaled;
  const divisor = BigInt(10) ** BigInt(scale);
  const intPart = abs / divisor;
  const fracPart = abs % divisor;
  const fracStr = fracPart.toString().padStart(scale, "0");

  return (negative ? "-" : "") + intPart.toString() + "." + fracStr;
}

// ============================================================================
// Date formatting (pure arithmetic, no JS Date)
// ============================================================================

/** Convert days since epoch to Y-M-D using Howard Hinnant's civil calendar algorithm.
 *  Uses BigInt internally to avoid floating-point precision issues with extreme dates. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = BigInt(days) + 719468n;
  const era = z >= 0n ? z / 146097n : (z - 146096n) / 146097n;
  const doe = Number(z - era * 146097n);
  const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365);
  let y = yoe + Number(era) * 400;
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const d = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  if (m <= 2) y++;
  return { year: y, month: m, day: d };
}

/** Format a date string with optional (BC) suffix. */
function formatCivilDate(year: number, month: number, day: number): string {
  const bc = year <= 0;
  const displayYear = bc ? 1 - year : year;
  const yStr = displayYear < 10000 ? String(displayYear).padStart(4, "0") : String(displayYear);
  const bcStr = bc ? " (BC)" : "";
  return `${yStr}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${bcStr}`;
}

/** Format a date from days since Unix epoch. */
function formatDateFromDays(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return formatCivilDate(year, month, day);
}

// ============================================================================
// Timestamp formatting (pure arithmetic, multiple precisions)
// ============================================================================

/** Get the timestamp unit from an Arrow type string.
 * Note: Arrow JS normalizes values — SECOND and MILLISECOND both become milliseconds,
 * MICROSECOND stays microseconds, NANOSECOND gets truncated to milliseconds (lossy).
 * The "unit" here means what Arrow actually gives us, not the original DuckDB type. */
function getTimestampUnit(typeStr: string): "s" | "ms" | "us" | "ns" {
  if (typeStr.includes("NANOSECOND") || typeStr.includes("Nanosecond")) return "ns";
  if (typeStr.includes("MICROSECOND") || typeStr.includes("Microsecond")) return "us";
  // Arrow converts SECOND and MILLISECOND to milliseconds
  if (typeStr.includes("SECOND") || typeStr.includes("Second")) return "ms";
  if (typeStr.includes("MILLISECOND") || typeStr.includes("Millisecond")) return "ms";
  return "us"; // default
}

/** Determine the display precision (fractional digits) for a timestamp type. */
function getTimestampDisplayPrecision(typeStr: string): number {
  if (typeStr.includes("NANOSECOND") || typeStr.includes("Nanosecond")) return 9;
  if (typeStr.includes("MICROSECOND") || typeStr.includes("Microsecond")) return 6;
  if (typeStr.includes("MILLISECOND") || typeStr.includes("Millisecond")) return 3;
  return 0; // SECOND
}

/** Format a timestamp value with the given unit precision. */
function formatTimestamp(value: any, unit: "s" | "ms" | "us" | "ns", tz: string | null, displayPrecision?: number): string {
  let v: bigint;
  if (typeof value === "bigint") {
    v = value;
  } else if (typeof value === "number") {
    v = BigInt(Math.round(value));
  } else {
    return String(value);
  }

  // Convert to nanoseconds internally to preserve max precision
  let totalNs: bigint;
  let fracDigits: number;
  switch (unit) {
    case "s":  totalNs = v * BigInt(1_000_000_000); fracDigits = 0; break;
    case "ms": totalNs = v * BigInt(1_000_000); fracDigits = 3; break;
    case "us": totalNs = v * BigInt(1_000); fracDigits = 6; break;
    case "ns": totalNs = v; fracDigits = 9; break;
  }
  // Override with display precision if explicitly provided
  if (displayPrecision !== undefined) fracDigits = displayPrecision;

  const nsPerSecond = BigInt(1_000_000_000);
  const nsPerMinute = BigInt(60) * nsPerSecond;
  const nsPerHour = BigInt(60) * nsPerMinute;
  const nsPerDay = BigInt(24) * nsPerHour;

  // Floor division for days
  let days: number;
  let remainder: bigint;
  if (totalNs >= BigInt(0)) {
    days = Number(totalNs / nsPerDay);
    remainder = totalNs % nsPerDay;
  } else {
    days = Number(totalNs / nsPerDay);
    remainder = totalNs % nsPerDay;
    if (remainder < BigInt(0)) {
      days--;
      remainder += nsPerDay;
    }
  }

  const hour = Number(remainder / nsPerHour);
  const minute = Number((remainder % nsPerHour) / nsPerMinute);
  const second = Number((remainder % nsPerMinute) / nsPerSecond);
  const fracNs = Number(remainder % nsPerSecond);

  const { year, month, day } = civilFromDays(days);
  const bc = year <= 0;
  const displayYear = bc ? 1 - year : year;
  const yStr = displayYear < 10000 ? String(displayYear).padStart(4, "0") : String(displayYear);
  const bcStr = bc ? " (BC)" : "";
  const dateStr = `${yStr}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;

  let fracStr = "";
  if (fracDigits > 0 && fracNs > 0) {
    const fullFrac = String(fracNs).padStart(9, "0"); // always 9 digits (nanoseconds)
    const trimmed = fullFrac.slice(0, fracDigits).replace(/0+$/, "");
    if (trimmed) fracStr = "." + trimmed;
  }

  // If timezone is specified (e.g., "UTC"), convert to local timezone
  if (tz) {
    // Get the timezone offset in seconds using DuckDB's timezone setting
    const tzName = _duckdbTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offsetSecs = getTimezoneOffsetSeconds(tzName, days, hour, minute, second);

    // Apply offset to the UTC nanoseconds
    const offsetNs = BigInt(offsetSecs) * nsPerSecond;
    const localNs = totalNs + offsetNs;

    // Recalculate days and time from local nanoseconds
    let localDays: number;
    let localRemainder: bigint;
    if (localNs >= BigInt(0)) {
      localDays = Number(localNs / nsPerDay);
      localRemainder = localNs % nsPerDay;
    } else {
      localDays = Number(localNs / nsPerDay);
      localRemainder = localNs % nsPerDay;
      if (localRemainder < BigInt(0)) {
        localDays--;
        localRemainder += nsPerDay;
      }
    }

    const lHour = Number(localRemainder / nsPerHour);
    const lMinute = Number((localRemainder % nsPerHour) / nsPerMinute);
    const lSecond = Number((localRemainder % nsPerMinute) / nsPerSecond);
    const lFracNs = Number(localRemainder % nsPerSecond);

    const { year: lYear, month: lMonth, day: lDay } = civilFromDays(localDays);
    const lBc = lYear <= 0;
    const lDisplayYear = lBc ? 1 - lYear : lYear;
    const lYStr = lDisplayYear < 10000 ? String(lDisplayYear).padStart(4, "0") : String(lDisplayYear);
    const lBcStr = lBc ? " (BC)" : "";
    const lDateStr = `${lYStr}-${String(lMonth).padStart(2, "0")}-${String(lDay).padStart(2, "0")}`;
    const lTimeStr = `${String(lHour).padStart(2, "0")}:${String(lMinute).padStart(2, "0")}:${String(lSecond).padStart(2, "0")}`;

    let lFracStr = "";
    if (fracDigits > 0 && lFracNs > 0) {
      const fullFrac = String(lFracNs).padStart(9, "0");
      const trimmed = fullFrac.slice(0, fracDigits).replace(/0+$/, "");
      if (trimmed) lFracStr = "." + trimmed;
    }

    // Format offset as ±HH[:MM]
    const absOff = Math.abs(offsetSecs);
    const offH = Math.floor(absOff / 3600);
    const offM = Math.floor((absOff % 3600) / 60);
    const offSign = offsetSecs >= 0 ? "+" : "-";
    const offStr = offM > 0 ? `${offSign}${String(offH).padStart(2, "0")}:${String(offM).padStart(2, "0")}`
      : `${offSign}${String(offH).padStart(2, "0")}`;

    return `${lDateStr}${lBcStr} ${lTimeStr}${lFracStr}${offStr}`;
  }

  return `${dateStr}${bcStr} ${timeStr}${fracStr}`;
}

// ============================================================================
// Time formatting
// ============================================================================

/** Format a time value. Unit is "us" (microseconds) or "ns" (nanoseconds). */
function formatTimeValue(value: any, unit: "us" | "ns", hasTz: boolean): string {
  let v: bigint;
  if (typeof value === "bigint") {
    v = value;
  } else if (typeof value === "number") {
    v = BigInt(Math.round(value));
  } else if (typeof value === "object" && value !== null) {
    // Arrow TimeTz may come as a struct with time + offset
    // Try to extract
    return String(value);
  } else {
    return String(value);
  }

  // Convert to nanoseconds
  const totalNs = unit === "us" ? v * BigInt(1000) : v;
  const fracDigits = unit === "us" ? 6 : 9;

  const nsPerSecond = BigInt(1_000_000_000);
  const nsPerMinute = BigInt(60) * nsPerSecond;
  const nsPerHour = BigInt(60) * nsPerMinute;

  const hour = Number(totalNs / nsPerHour);
  const minute = Number((totalNs % nsPerHour) / nsPerMinute);
  const second = Number((totalNs % nsPerMinute) / nsPerSecond);
  const fracNs = Number(totalNs % nsPerSecond);

  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;

  let fracStr = "";
  if (fracNs > 0) {
    const fullFrac = String(fracNs).padStart(9, "0");
    const trimmed = fullFrac.slice(0, fracDigits).replace(/0+$/, "");
    if (trimmed) fracStr = "." + trimmed;
  }

  // TODO: timezone offset for TIME WITH TIME ZONE
  return `${timeStr}${fracStr}`;
}

// ============================================================================
// Interval formatting
// ============================================================================

/** Format an interval value. */
function formatInterval(value: any): string {
  let months = 0, days = 0, micros = 0;

  if (typeof value === "object" && value !== null) {
    months = value.months ?? value[0] ?? 0;
    days = value.days ?? value[1] ?? 0;
    const ns = value.nanoseconds ?? value[2] ?? 0;
    micros = typeof ns === "bigint" ? Number(ns / 1000n) : Math.floor(Number(ns) / 1000);
  }

  const parts: string[] = [];
  const years = Math.floor(months / 12);
  const remainMonths = months % 12;
  if (years !== 0) parts.push(`${years} year${years !== 1 ? "s" : ""}`);
  if (remainMonths !== 0) parts.push(`${remainMonths} month${remainMonths !== 1 ? "s" : ""}`);
  if (days !== 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);

  // Time component from microseconds
  const absMicros = Math.abs(micros);
  const hours = Math.floor(absMicros / 3600000000);
  const mins = Math.floor((absMicros % 3600000000) / 60000000);
  const secs = Math.floor((absMicros % 60000000) / 1000000);
  const fracUs = absMicros % 1000000;
  const sign = micros < 0 ? "-" : "";
  let timeStr = `${sign}${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  if (fracUs > 0) {
    timeStr += "." + String(fracUs).padStart(6, "0").replace(/0+$/, "");
  }

  if (parts.length === 0 && micros === 0) return "00:00:00";
  if (parts.length > 0 && micros === 0) return parts.join(" ") + " 00:00:00";
  if (parts.length === 0) return timeStr;
  return parts.join(" ") + " " + timeStr;
}

/** Format DuckDB BIT extension type — first byte is padding count (bits to skip at start). */
function formatBitString(bytes: Uint8Array): string {
  if (bytes.length < 2) return "";
  const padding = bytes[0];
  let bits = "";
  for (let i = 1; i < bytes.length; i++) {
    bits += bytes[i].toString(2).padStart(8, "0");
  }
  // Remove padding bits from the start
  return bits.slice(padding);
}

/** Format BLOB as DuckDB-style hex string — printable ASCII shown as-is, others as \xHH. */
function formatBlob(bytes: Uint8Array): string {
  let result = "";
  for (const b of bytes) {
    if (b >= 32 && b < 127 && b !== 92) { // printable ASCII except backslash
      result += String.fromCharCode(b);
    } else {
      result += "\\x" + b.toString(16).padStart(2, "0");
    }
  }
  return result;
}

// ============================================================================
// Exports for other modules
// ============================================================================

/** Check if a value is null/undefined. */
// ============================================================================
// Timezone offset calculation (for timestamp_tz display)
// ============================================================================

/** Get timezone offset in seconds (positive = east of UTC) for a given IANA timezone
 *  and a UTC date/time. Uses Intl.DateTimeFormat for DST-aware resolution.
 *  For dates outside JS Date range, uses the standard (non-DST) offset. */
function getTimezoneOffsetSeconds(tzName: string, utcDays: number, utcHour: number, utcMinute: number, utcSecond: number): number {
  // Try to construct a Date within JS range to get DST-aware offset
  const utcMs = (utcDays * 86400 + utcHour * 3600 + utcMinute * 60 + utcSecond) * 1000;
  if (utcMs >= -8.64e15 && utcMs <= 8.64e15) {
    try {
      // Use Intl to format in the target timezone and compare with UTC
      const d = new Date(utcMs);
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tzName,
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric",
        hour12: false,
      });
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
      const localY = parseInt(parts.year);
      const localM = parseInt(parts.month);
      const localD = parseInt(parts.day);
      const localH = parseInt(parts.hour) % 24;
      const localMin = parseInt(parts.minute);
      const localS = parseInt(parts.second);
      // Compute offset = local - utc in seconds
      const utcTotalSec = utcDays * 86400 + utcHour * 3600 + utcMinute * 60 + utcSecond;
      // Convert local back to epoch seconds using civil calendar
      const { year: uY, month: uM, day: uD } = civilFromDays(utcDays);
      // If same date, offset is just the time difference
      if (localY === uY && localM === uM && localD === uD) {
        const localTotalSec = localH * 3600 + localMin * 60 + localS;
        const utcTimeSec = utcHour * 3600 + utcMinute * 60 + utcSecond;
        return localTotalSec - utcTimeSec;
      }
      // Different date — compute full difference
      // Use getTimezoneOffset as fallback for cross-day differences
      return -d.getTimezoneOffset() * 60;
    } catch { /* fallback below */ }
  }

  // For extreme dates outside JS Date range, use the standard offset
  // (non-DST) for the timezone. Get it from a winter date.
  try {
    const winterDate = new Date(Date.UTC(2024, 0, 15)); // Jan 15 — no DST anywhere
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
      hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(winterDate)) parts[p.type] = p.value;
    const localH = parseInt(parts.hour) % 24;
    const localMin = parseInt(parts.minute);
    const localD = parseInt(parts.day);
    // Jan 15 2024 00:00 UTC → local time difference = offset
    const localTotalMin = (localD === 15 ? 0 : localD === 16 ? 1440 : -1440) + localH * 60 + localMin;
    return localTotalMin * 60;
  } catch {
    return 0; // UTC fallback
  }
}

// ============================================================================
// DuckDB Arrow extension type helpers (arrow_lossless_conversion=true)
// ============================================================================

/** Extract DuckDB type name from Arrow extension metadata. */
function getDuckDBExtensionType(field: any): string | null {
  try {
    const extMeta = field.metadata?.get?.("ARROW:extension:metadata");
    if (extMeta) {
      const parsed = JSON.parse(extMeta);
      return parsed?.type_name ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

/** Format a 16-byte FixedSizeBinary as a signed or unsigned 128-bit integer. */
/** Read a 16-byte FixedSizeBinary as a signed or unsigned 128-bit BigInt. */
function readInt128(bytes: Uint8Array, signed: boolean): bigint {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const lo = dv.getBigUint64(0, true);
  const hi = dv.getBigUint64(8, true);
  const raw = lo | (hi << 64n);
  if (!signed) return raw;
  const signBit = 1n << 127n;
  if (raw & signBit) {
    const mask = (1n << 128n) - 1n;
    return -(((raw ^ mask) + 1n) & mask);
  }
  return raw;
}

/** Format an Arrow Vector value (List, Struct, Map) in DuckDB's display style. */
function formatArrowValue(value: any, field?: any): string {
  const type = value.type ?? field?.type;
  const typeStr = type?.toString() || "";

  // Struct: {'field': value, ...}
  if (typeStr.startsWith("Struct")) {
    try {
      const obj = typeof value.toJSON === "function" ? value.toJSON() : value;
      return formatPlainStruct(obj);
    } catch { /* fall through */ }
  }

  // Map: {key1=value1, key2=value2}
  if (typeStr.startsWith("Map")) {
    try {
      const entries: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const entry = value.get(i);
        if (!entry) continue;
        const k = entry.key ?? entry.get?.(0) ?? entry.get?.("key");
        const v = entry.value ?? entry.get?.(1) ?? entry.get?.("value");
        const fk = k === null || k === undefined ? "NULL" : formatNestedValue(k);
        const fv = v === null || v === undefined ? "NULL" : formatNestedValue(v);
        entries.push(`${fk}=${fv}`);
      }
      return `{${entries.join(", ")}}`;
    } catch {
      return "{}";
    }
  }

  // List/FixedSizeList/Array: [val1, val2, ...]
  try {
    const len = value.length ?? value.numRows ?? 0;
    const parts: string[] = [];
    for (let i = 0; i < len; i++) {
      const item = value.get(i);
      if (item === null || item === undefined) {
        parts.push("NULL");
      } else {
        parts.push(formatNestedValue(item));
      }
    }
    return `[${parts.join(", ")}]`;
  } catch {
    return String(value);
  }
}

/** Format a plain JS object as DuckDB-style struct: {'key': value, ...} */
function formatPlainStruct(obj: any): string {
  const entries = Object.entries(obj);
  const parts = entries.map(([k, v]) => {
    const formatted = v === null || v === undefined ? "NULL" : formatNestedValue(v);
    return `'${k}': ${formatted}`;
  });
  return `{${parts.join(", ")}}`;
}

/** Format a nested value inside an array/struct for DuckDB-style display. */
function formatNestedValue(val: any): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "object" && val !== null) {
    if (val.__rawDays !== undefined) return formatDateFromDays(val.__rawDays);
    if (val.__int128 !== undefined) return (val.__int128 as bigint).toString();
    if (val.__uint128 !== undefined) return (val.__uint128 as bigint).toString();
    if (val.__timeTz !== undefined) return formatCellValue(val);
    if (val.__uuid !== undefined) return formatUUID(val.__uuid);
    if (val instanceof Uint8Array) return "[binary]";
    if (typeof val.toArray === "function") return formatArrowValue(val);
    if (val instanceof Date) return formatDateFromDays(Math.floor(val.getTime() / 86400000));
    // Plain struct object
    if (!Array.isArray(val) && !(val instanceof Int32Array) && !(val instanceof Float64Array)) {
      return formatPlainStruct(val);
    }
    try { return JSON.stringify(val); } catch { return "[object]"; }
  }
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return val.toString();
  return String(val);
}

/** Format DuckDB's BIGNUM binary format to a decimal string.
 *  Header (3 bytes): byte[0] bit 7 = sign (0=negative, 1=positive),
 *  remaining 23 bits = data byte count.
 *  Data bytes: big-endian magnitude. For negative, bytes are bitwise inverted. */
function formatBignum(bytes: Uint8Array): string {
  if (bytes.length < 3) return "0";
  const HEADER_SIZE = 3;
  const isPositive = (bytes[0] & 0x80) !== 0;
  // Data byte count from header (23 bits: 7 bits of byte[0] + byte[1] + byte[2])
  const dataSize = ((bytes[0] & 0x7F) << 16) | (bytes[1] << 8) | bytes[2];
  if (dataSize === 0) return "0";

  // Extract magnitude bytes (big-endian). For negative, invert each byte.
  let magnitude = BigInt(0);
  for (let i = 0; i < dataSize && HEADER_SIZE + i < bytes.length; i++) {
    let b = bytes[HEADER_SIZE + i];
    if (!isPositive) b = (~b) & 0xFF;
    magnitude = (magnitude << 8n) | BigInt(b);
  }

  return isPositive ? magnitude.toString() : "-" + magnitude.toString();
}

/** Format a 16-byte FixedSizeBinary as a signed or unsigned 128-bit integer. */
function formatFixedBinaryInt128(bytes: Uint8Array, signed: boolean): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const lo = dv.getBigUint64(0, true);
  const hi = dv.getBigUint64(8, true);
  const raw = lo | (hi << 64n);
  if (!signed) return raw.toString();
  // Signed: two's complement
  const signBit = 1n << 127n;
  if (raw & signBit) {
    const mask = (1n << 128n) - 1n;
    return "-" + (((raw ^ mask) + 1n) & mask).toString();
  }
  return raw.toString();
}

/** Format an 8-byte FixedSizeBinary as DuckDB's TIME WITH TIME ZONE.
 *  DuckDB packs time_tz as: bits[63:24] = microseconds, bits[23:0] = offset_encoded
 *  where offset_encoded = 57599 - offset_seconds (so UTC+00 = 57599, max = 115198) */
function formatFixedBinaryTimeTz(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const raw = dv.getBigUint64(0, true);
  const micros = Number(raw >> 24n);
  const encodedOffset = Number(raw & 0xFFFFFFn);
  const offsetSecs = 57599 - encodedOffset; // positive = east of UTC

  const timeStr = formatTimeValue(micros, "us", false);
  const absOff = Math.abs(offsetSecs);
  const offH = Math.floor(absOff / 3600);
  const offM = Math.floor((absOff % 3600) / 60);
  const offS = absOff % 60;
  const offSign = offsetSecs >= 0 ? "+" : "-";
  let offStr = `${offSign}${String(offH).padStart(2, "0")}`;
  if (offM > 0 || offS > 0) offStr += `:${String(offM).padStart(2, "0")}`;
  if (offS > 0) offStr += `:${String(offS).padStart(2, "0")}`;
  return `${timeStr}${offStr}`;
}

/** Format a 16-byte FixedSizeBinary as a UUID string. */
function formatUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Safely read a value from an Arrow column, handling:
 * - BigInt overflow (Arrow throws for values outside safe integer range)
 * - Date32 precision loss (reads raw int32 days instead of lossy milliseconds)
 * - Nanosecond timestamp precision (reads raw BigInt64)
 * - Dictionary/enum resolution (manual lookup when Arrow JS fails)
 * - Extension types (hugeint, uhugeint, time_tz as FixedSizeBinary)
 */
export function safeGetArrowValue(column: any, row: number, field?: any): any {
  if (!column) return null;

  const typeStr = column.type?.toString() || "";

  // Interval<MONTH_DAY_NANO>: read raw 16-byte struct (4+4+8) from data buffer
  if (typeStr.includes("Interval")) {
    const chunk = column.data?.[0] ?? column.data;
    if (chunk?.values) {
      const idx = row - (chunk.offset ?? 0);
      const nullBitmap = chunk.nullBitmap;
      if (nullBitmap && nullBitmap.length > 0) {
        const byteIdx = idx >> 3;
        const bitIdx = idx & 7;
        if (byteIdx < nullBitmap.length && (nullBitmap[byteIdx] & (1 << bitIdx)) === 0) return null;
      }
      // MONTH_DAY_NANO: 16 bytes per value — int32 months, int32 days, int64 nanoseconds
      const byteOffset = idx * 16;
      const dv = new DataView(chunk.values.buffer, chunk.values.byteOffset + byteOffset, 16);
      return {
        __interval: {
          months: dv.getInt32(0, true),
          days: dv.getInt32(4, true),
          nanoseconds: dv.getBigInt64(8, true),
        }
      };
    }
  }

  // FixedSizeBinary extension types (arrow_lossless_conversion=true):
  // hugeint, uhugeint, time_tz, uuid
  if (typeStr.startsWith("FixedSizeBinary")) {
    const meta = field?.metadata ?? column.type?.metadata;
    let extTypeName: string | null = null;
    let extName: string | null = null;
    try {
      const extMeta = meta?.get?.("ARROW:extension:metadata");
      if (extMeta) extTypeName = JSON.parse(extMeta)?.type_name ?? null;
      extName = meta?.get?.("ARROW:extension:name") ?? null;
    } catch { /* ignore */ }

    if (extTypeName || extName) {
      const chunk = column.data?.[0] ?? column.data;
      if (chunk) {
        const byteWidth = column.type?.byteWidth ?? (extTypeName === "time_tz" ? 8 : 16);
        const adjustedRow = row - (chunk.offset ?? 0);
        const nullBitmap = chunk.nullBitmap;
        if (nullBitmap && nullBitmap.length > 0) {
          const byteIdx = adjustedRow >> 3;
          const bitIdx = adjustedRow & 7;
          if (byteIdx < nullBitmap.length && (nullBitmap[byteIdx] & (1 << bitIdx)) === 0) return null;
        }
        const values = chunk.values;
        if (values) {
          const offset = adjustedRow * byteWidth;
          const bytes = new Uint8Array(values.buffer, values.byteOffset + offset, byteWidth);
          if (extTypeName === "hugeint") return { __int128: readInt128(bytes, true) };
          if (extTypeName === "uhugeint") return { __uint128: readInt128(bytes, false) };
          if (extTypeName === "time_tz") {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
            const raw = dv.getBigUint64(0, true);
            return { __timeTz: { micros: Number(raw >> 24n), offsetSecs: 57599 - Number(raw & 0xFFFFFFn) } };
          }
          if (extName === "arrow.uuid") return { __uuid: bytes.slice() };
        }
      }
    }
  }

  // arrow.bool8: Int8 representing boolean
  if (field?.metadata?.get?.("ARROW:extension:name") === "arrow.bool8") {
    try {
      const val = column.get(row);
      if (val === null || val === undefined) return null;
      return val !== 0;
    } catch { return null; }
  }

  // Date32: read raw int32 days to avoid precision loss from Arrow's ms conversion
  if (typeStr.includes("Date32")) {
    const chunk = column.data?.[0] ?? column.data;
    if (chunk?.values instanceof Int32Array) {
      const idx = row - (chunk.offset ?? 0);
      const nullBitmap = chunk.nullBitmap;
      if (nullBitmap && nullBitmap.length > 0) {
        const byteIdx = idx >> 3;
        const bitIdx = idx & 7;
        if (byteIdx < nullBitmap.length && (nullBitmap[byteIdx] & (1 << bitIdx)) === 0) return null;
      }
      if (chunk.nullCount > 0 && !nullBitmap) return null;
      return { __rawDays: chunk.values[idx] };
    }
  }

  // Timestamp<NANOSECOND>: Arrow truncates BigInt64 to Number, losing precision.
  if (typeStr.includes("NANOSECOND")) {
    const chunk = column.data?.[0] ?? column.data;
    const values = chunk?.values;
    if (values instanceof BigInt64Array) {
      const idx = row - (chunk.offset ?? 0);
      const nullBitmap = chunk.nullBitmap;
      if (nullBitmap && nullBitmap.length > 0) {
        const byteIdx = idx >> 3;
        const bitIdx = idx & 7;
        if (byteIdx < nullBitmap.length && (nullBitmap[byteIdx] & (1 << bitIdx)) === 0) return null;
      }
      return values[idx];
    }
  }

  // Dictionary/Enum: manual resolution when Arrow JS CDN fails
  if (typeStr.includes("Dictionary")) {
    const chunk = column.data?.[0] ?? column.data;
    if (chunk) {
      const idx = row - (chunk.offset ?? 0);
      const nullBitmap = chunk.nullBitmap;
      if (nullBitmap && nullBitmap.length > 0) {
        const byteIdx = idx >> 3;
        const bitIdx = idx & 7;
        if (byteIdx < nullBitmap.length && (nullBitmap[byteIdx] & (1 << bitIdx)) === 0) return null;
      }
      const dictIdx = chunk.values?.[idx];
      if (dictIdx !== null && dictIdx !== undefined) {
        const dict = chunk.dictionary ?? column.data?.dictionary ?? column.dictionary;
        if (dict) {
          try {
            if (typeof dict.get === "function") {
              const val = dict.get(dictIdx);
              if (val !== null && val !== undefined) return val;
            }
            const inner = dict.data?.[0] ?? dict.data;
            if (inner?.values && inner?.valueOffsets) {
              const start = inner.valueOffsets[dictIdx];
              const end = inner.valueOffsets[dictIdx + 1];
              if (start !== undefined && end !== undefined) {
                return new TextDecoder().decode(inner.values.subarray(start, end));
              }
            }
          } catch { /* fall through to column.get */ }
        }
      }
    }
  }

  try {
    return column.get(row);
  } catch {
    // BigInt overflow — read raw value from underlying typed array
    const chunk = column.data?.[0] ?? column.data;
    const values = chunk?.values;
    if (values instanceof BigInt64Array || values instanceof BigUint64Array) {
      const idx = row - (chunk?.offset ?? 0);
      if (idx >= 0 && idx < values.length) return values[idx];
    }
    if (values instanceof Uint32Array) {
      const typeWidth = chunk?.type?.bitWidth;
      if (typeWidth === 128) {
        const wordsPerValue = 4;
        const idx = (row - (chunk?.offset ?? 0)) * wordsPerValue;
        if (idx >= 0 && idx + wordsPerValue <= values.length) {
          return values.slice(idx, idx + wordsPerValue);
        }
      }
    }
    return null;
  }
}

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

  if (DATE_TYPES.has(baseType)) {
    const fmt = (v: any) => {
      if (v == null) return "?";
      const s = String(v);
      if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
      return s;
    };
    return `${fmt(min)}..${fmt(max)}`;
  }

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

  if (baseType === "GEOMETRY") return "[bbox]";

  if (TIMESTAMP_TYPES.has(baseType)) {
    const fmt = (v: any) => {
      if (v == null) return "?";
      return String(v).slice(0, 16);
    };
    return `${fmt(min)}..${fmt(max)}`;
  }

  return "";
}
