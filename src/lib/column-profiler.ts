/**
 * Column profiling — generates DuckDB SQL queries per column type,
 * executes them via the shell bridge, and parses Arrow IPC results.
 */

import { bridge } from "./shell-bridge";
import type { ColumnStats } from "./service";

// ============================================================================
// Type classification
// ============================================================================

export type ColumnCategory = "numeric" | "string" | "date" | "boolean" | "geometry" | "unsupported";

const NUMERIC_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
  "FLOAT", "DOUBLE", "REAL",
]);

const DATE_TYPES = new Set(["DATE", "DATE32", "DATE64"]);

const TIMESTAMP_TYPES = new Set([
  "TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_US", "TIMESTAMP_NS",
  "TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ", "DATETIME",
]);

export function classifyColumnType(duckdbType: string): ColumnCategory {
  const base = duckdbType.split("(")[0].toUpperCase().trim();
  if (NUMERIC_TYPES.has(base) || base.startsWith("DECIMAL")) return "numeric";
  if (DATE_TYPES.has(base) || TIMESTAMP_TYPES.has(base)) return "date";
  if (base === "BOOLEAN") return "boolean";
  if (base === "GEOMETRY") return "geometry";
  if (base === "VARCHAR" || base === "TEXT" || base === "STRING" || base === "ENUM") return "string";
  // BLOB, JSON, STRUCT, LIST, MAP, etc. — still show basic null ratio
  return "string";
}

// ============================================================================
// Profile data types
// ============================================================================

export interface Bar {
  label: string;
  value: number;
}

export interface NumericProfile {
  kind: "numeric";
  total: number;
  nonNull: number;
  avg: number | null;
  median: number | null;
  stddev: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  histogram: Bar[];
  sampled: number | null; // null = full table
}

export interface StringProfile {
  kind: "string";
  total: number;
  nonNull: number;
  minValue: string | null;
  maxValue: string | null;
  avgLength: number | null;
  minLength: number | null;
  maxLength: number | null;
  emptyCount: number;
  distinctCount: number;
  topValues: Bar[];
  sampled: number | null;
}

export interface DateProfile {
  kind: "date";
  total: number;
  nonNull: number;
  histogram: Bar[];
  bucketUnit: string;
  sampled: number | null;
}

export interface BooleanProfile {
  kind: "boolean";
  total: number;
  trueCount: number;
  falseCount: number;
  nullCount: number;
}

export interface GeometryProfile {
  kind: "geometry";
  total: number;
  nonNull: number;
  typeBreakdown: Bar[];
  sampled: number | null;
}

export type ProfileData = NumericProfile | StringProfile | DateProfile | BooleanProfile | GeometryProfile;

// ============================================================================
// Query helpers
// ============================================================================

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tablePath(catalog: string, schema: string, table: string): string {
  return `${quoteIdent(catalog)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
}

const SAMPLE_THRESHOLD = 50_000;
const SAMPLE_SIZE = 10_000;

function sampleClause(rowCount: number | null): string {
  if (rowCount != null && rowCount > SAMPLE_THRESHOLD) {
    return ` TABLESAMPLE RESERVOIR(${SAMPLE_SIZE})`;
  }
  return "";
}

// ============================================================================
// Query execution
// ============================================================================

async function runQuery(sql: string): Promise<any[] | null> {
  const queryFn = bridge.query;
  if (!queryFn) return null;

  const result = await queryFn(sql);
  if (!result.ok || !result.arrowBuffers?.length) return null;

  const { tableFromIPC } = await import("apache-arrow");
  const buf = result.arrowBuffers[0];
  const table = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);

  const rows: any[] = [];
  const fields = table.schema.fields;
  for (let i = 0; i < table.numRows; i++) {
    const row: any = {};
    for (let c = 0; c < fields.length; c++) {
      row[fields[c].name] = table.getChildAt(c)?.get(i) ?? null;
    }
    rows.push(row);
  }
  return rows;
}

async function getRowCount(catalog: string, schema: string, table: string): Promise<number | null> {
  const tbl = tablePath(catalog, schema, table);
  const rows = await runQuery(`SELECT COUNT(*) as cnt FROM ${tbl}`);
  if (!rows?.length) return null;
  return Number(rows[0].cnt);
}

// ============================================================================
// Fetch profile per column type
// ============================================================================

export async function fetchColumnProfile(
  catalog: string,
  schema: string,
  table: string,
  columnName: string,
  columnType: string,
  existingStats: ColumnStats | undefined,
): Promise<ProfileData> {
  const category = classifyColumnType(columnType);
  const tbl = tablePath(catalog, schema, table);
  const col = quoteIdent(columnName);
  const rowCount = await getRowCount(catalog, schema, table);
  const sample = sampleClause(rowCount);
  const sampled = (rowCount != null && rowCount > SAMPLE_THRESHOLD) ? SAMPLE_SIZE : null;

  switch (category) {
    case "numeric":
      return fetchNumericProfile(tbl, col, sample, sampled, existingStats);
    case "date":
      return fetchDateProfile(tbl, col, sample, sampled, existingStats);
    case "boolean":
      return fetchBooleanProfile(tbl, col, sample);
    case "geometry":
      return fetchGeometryProfile(tbl, col, sample, sampled);
    case "string":
    default:
      return fetchStringProfile(tbl, col, sample, sampled);
  }
}

async function fetchNumericProfile(
  tbl: string, col: string, sample: string, sampled: number | null, stats?: ColumnStats,
): Promise<NumericProfile> {
  // Summary stats
  const summaryRows = await runQuery(
    `SELECT COUNT(*) as total, COUNT(${col}) as non_null, ` +
    `ROUND(AVG(${col})::DOUBLE, 4) as avg_val, ` +
    `ROUND(MEDIAN(${col})::DOUBLE, 4) as median_val, ` +
    `ROUND(STDDEV(${col})::DOUBLE, 4) as stddev_val, ` +
    `quantile_disc(${col}, 0.10) as p10, ` +
    `quantile_disc(${col}, 0.25) as p25, ` +
    `quantile_disc(${col}, 0.75) as p75, ` +
    `quantile_disc(${col}, 0.90) as p90 ` +
    `FROM ${tbl}${sample}`
  );
  const s = summaryRows?.[0] ?? {};
  const total = Number(s.total ?? 0);
  const nonNull = Number(s.non_null ?? 0);

  // Histogram — use existing min/max from stats if available
  let histogram: Bar[] = [];
  const minVal = stats?.min != null ? Number(stats.min) : null;
  const maxVal = stats?.max != null ? Number(stats.max) : null;

  if (minVal != null && maxVal != null && !isNaN(minVal) && !isNaN(maxVal) && minVal < maxVal) {
    const buckets = 10;
    const histRows = await runQuery(
      `SELECT width_bucket(${col}::DOUBLE, ${minVal}::DOUBLE, ${maxVal + 1e-9}::DOUBLE, ${buckets}) as bucket, ` +
      `COUNT(*) as cnt ` +
      `FROM ${tbl}${sample} WHERE ${col} IS NOT NULL ` +
      `GROUP BY bucket ORDER BY bucket`
    );
    if (histRows) {
      const step = (maxVal - minVal) / buckets;
      histogram = histRows.map((r) => {
        const b = Number(r.bucket) - 1; // width_bucket is 1-based
        const lo = minVal + b * step;
        const hi = lo + step;
        return {
          label: formatBucketLabel(lo, hi),
          value: Number(r.cnt),
        };
      });
    }
  }

  return {
    kind: "numeric",
    total,
    nonNull,
    avg: toNum(s.avg_val),
    median: toNum(s.median_val),
    stddev: toNum(s.stddev_val),
    p10: toNum(s.p10),
    p25: toNum(s.p25),
    p75: toNum(s.p75),
    p90: toNum(s.p90),
    min: minVal,
    max: maxVal,
    histogram,
    sampled,
  };
}

async function fetchStringProfile(
  tbl: string, col: string, sample: string, sampled: number | null,
): Promise<StringProfile> {
  // Top-K frequency
  const rows = await runQuery(
    `SELECT ${col} as value, COUNT(*) as cnt ` +
    `FROM ${tbl}${sample} WHERE ${col} IS NOT NULL ` +
    `GROUP BY ${col} ORDER BY cnt DESC LIMIT 10`
  );

  // Summary: counts, min/max, length stats, empty strings, distinct count
  const summaryRows = await runQuery(
    `SELECT COUNT(*) as total, COUNT(${col}) as non_null, ` +
    `MIN(${col}) as min_val, MAX(${col}) as max_val, ` +
    `ROUND(AVG(LENGTH(${col})), 1) as avg_len, ` +
    `MIN(LENGTH(${col})) as min_len, ` +
    `MAX(LENGTH(${col})) as max_len, ` +
    `COUNT(CASE WHEN ${col} = '' THEN 1 END) as empty_count, ` +
    `COUNT(DISTINCT ${col}) as distinct_count ` +
    `FROM ${tbl}${sample}`
  );
  const s = summaryRows?.[0] ?? {};

  const topValues: Bar[] = (rows ?? []).map((r) => ({
    label: truncate(String(r.value ?? ""), 40),
    value: Number(r.cnt),
  }));

  return {
    kind: "string",
    total: Number(s.total ?? 0),
    nonNull: Number(s.non_null ?? 0),
    minValue: s.min_val != null ? String(s.min_val) : null,
    maxValue: s.max_val != null ? String(s.max_val) : null,
    avgLength: toNum(s.avg_len),
    minLength: s.min_len != null ? Number(s.min_len) : null,
    maxLength: s.max_len != null ? Number(s.max_len) : null,
    emptyCount: Number(s.empty_count ?? 0),
    distinctCount: Number(s.distinct_count ?? 0),
    topValues,
    sampled,
  };
}

async function fetchDateProfile(
  tbl: string, col: string, sample: string, sampled: number | null, stats?: ColumnStats,
): Promise<DateProfile> {
  // Determine bucket unit from min/max range
  let bucketUnit = "year";
  if (stats?.min != null && stats?.max != null) {
    const minDate = new Date(String(stats.min));
    const maxDate = new Date(String(stats.max));
    const spanDays = (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
    if (spanDays < 730) bucketUnit = "month";
    else if (spanDays >= 10950) bucketUnit = "decade";
  }

  const rows = await runQuery(
    `SELECT DATE_TRUNC(${quoteLiteral(bucketUnit)}, ${col}) as period, COUNT(*) as cnt ` +
    `FROM ${tbl}${sample} WHERE ${col} IS NOT NULL ` +
    `GROUP BY period ORDER BY period`
  );

  // Also get total/non-null
  const countRows = await runQuery(
    `SELECT COUNT(*) as total, COUNT(${col}) as non_null FROM ${tbl}${sample}`
  );
  const c = countRows?.[0] ?? {};

  const histogram: Bar[] = (rows ?? []).map((r) => ({
    label: formatDateLabel(r.period, bucketUnit),
    value: Number(r.cnt),
  }));

  return {
    kind: "date",
    total: Number(c.total ?? 0),
    nonNull: Number(c.non_null ?? 0),
    histogram,
    bucketUnit,
    sampled,
  };
}

async function fetchBooleanProfile(
  tbl: string, col: string, sample: string,
): Promise<BooleanProfile> {
  const rows = await runQuery(
    `SELECT ${col} as value, COUNT(*) as cnt ` +
    `FROM ${tbl}${sample} GROUP BY ${col} ORDER BY ${col}`
  );

  let trueCount = 0, falseCount = 0, nullCount = 0;
  for (const r of rows ?? []) {
    const cnt = Number(r.cnt);
    if (r.value === true) trueCount = cnt;
    else if (r.value === false) falseCount = cnt;
    else nullCount = cnt;
  }

  return {
    kind: "boolean",
    total: trueCount + falseCount + nullCount,
    trueCount,
    falseCount,
    nullCount,
  };
}

async function fetchGeometryProfile(
  tbl: string, col: string, sample: string, sampled: number | null,
): Promise<GeometryProfile> {
  // Get total/non-null count
  const countRows = await runQuery(
    `SELECT COUNT(*) as total, COUNT(${col}) as non_null FROM ${tbl}${sample}`
  );
  const c = countRows?.[0] ?? {};

  // Try ST_GeometryType directly (column is already GEOMETRY type),
  // fall back to ST_GeomFromWKB if that fails (raw WKB binary)
  let rows = await runQuery(
    `SELECT ST_GeometryType(${col}) as geom_type, COUNT(*) as cnt ` +
    `FROM ${tbl}${sample} WHERE ${col} IS NOT NULL ` +
    `GROUP BY geom_type ORDER BY cnt DESC`
  );
  if (!rows) {
    rows = await runQuery(
      `SELECT ST_GeometryType(ST_GeomFromWKB(${col})) as geom_type, COUNT(*) as cnt ` +
      `FROM ${tbl}${sample} WHERE ${col} IS NOT NULL ` +
      `GROUP BY geom_type ORDER BY cnt DESC`
    );
  }

  const typeBreakdown: Bar[] = (rows ?? []).map((r) => ({
    label: String(r.geom_type ?? "Unknown"),
    value: Number(r.cnt),
  }));

  return {
    kind: "geometry",
    total: Number(c.total ?? 0),
    nonNull: Number(c.non_null ?? 0),
    typeBreakdown,
    sampled,
  };
}

// ============================================================================
// Formatting helpers
// ============================================================================

function toNum(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function formatBucketLabel(lo: number, hi: number): string {
  const fmt = (n: number) => {
    if (Number.isInteger(n) && Math.abs(n) < 1e6) return n.toLocaleString();
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };
  return `${fmt(lo)} – ${fmt(hi)}`;
}

function formatDateLabel(value: any, unit: string): string {
  if (value == null) return "?";
  const s = String(value);
  // Dates come through as ISO strings or epoch numbers
  const d = new Date(typeof value === "number" ? value : s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  if (unit === "month") return d.toISOString().slice(0, 7); // YYYY-MM
  if (unit === "decade") return `${Math.floor(d.getFullYear() / 10) * 10}s`;
  return String(d.getFullYear()); // year
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
