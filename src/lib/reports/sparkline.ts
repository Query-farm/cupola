export interface SparklineDatum {
  value: number;
  row: Record<string, any>;
}

export interface SparklineSeries {
  data: SparklineDatum[];
  points: string;
  areaPoints: string;
  latest: SparklineDatum | null;
}

export interface SparklineSplit {
  /** Index of the first row in the after/forecast portion. */
  index: number;
  /** Normalized x coordinate halfway between the before and after points. */
  x: number;
}

export interface SparklineHeadline {
  datum: SparklineDatum;
  index: number;
  value: unknown;
}

function marksSparklineSplit(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "forecast", "future", "after"].includes(value.trim().toLowerCase());
}

/** Locate a data-driven boundary. SQL boolean columns are preferred, while
 * common textual phase values make canned and imported datasets ergonomic. */
export function findSparklineSplit(series: SparklineSeries, splitColumn: string): SparklineSplit | null {
  const index = series.data.findIndex((datum) => marksSparklineSplit(datum.row[splitColumn]));
  if (index < 0) return null;
  if (series.data.length === 1) return { index, x: 50 };
  const x = index === 0 ? 0 : ((index - 0.5) / (series.data.length - 1)) * 100;
  return { index, x };
}

/** Select the value a compact trend should headline. A forecast endpoint is
 * rarely the current value, so split series default to the final point before
 * the boundary. Authors can select another semantic row and/or a separate
 * value column without persisting a stale literal in the report definition. */
export function selectSparklineHeadline(
  series: SparklineSeries,
  split: SparklineSplit | null,
  rowMode?: "last" | "last_observed" | "first_forecast",
  headlineValueColumn?: string,
): SparklineHeadline | null {
  if (series.data.length === 0) return null;
  const mode = rowMode ?? (split ? "last_observed" : "last");
  let index = series.data.length - 1;
  if (mode === "last_observed" && split && split.index > 0) index = split.index - 1;
  else if (mode === "first_forecast" && split) index = split.index;
  const datum = series.data[index];
  return {
    datum,
    index,
    value: headlineValueColumn ? datum.row[headlineValueColumn] : datum.value,
  };
}

/** Build a normalized 100×32 sparkline from rows in query-result order. */
export function buildSparklineSeries(rows: Record<string, any>[], valueColumn: string): SparklineSeries {
  const data = rows.flatMap((row) => {
    const raw = row[valueColumn];
    if (raw == null || raw === "" || typeof raw === "boolean") return [];
    const value = Number(raw);
    return Number.isFinite(value) ? [{ value, row }] : [];
  });
  if (data.length === 0) return { data, points: "", areaPoints: "", latest: null };
  const min = Math.min(...data.map((datum) => datum.value));
  const max = Math.max(...data.map((datum) => datum.value));
  const span = max - min;
  const points = data.map((datum, index) => {
    const x = data.length === 1 ? 50 : (index / (data.length - 1)) * 100;
    const y = span === 0 ? 16 : 30 - ((datum.value - min) / span) * 28;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return {
    data,
    points,
    areaPoints: `0,32 ${points} 100,32`,
    latest: data[data.length - 1],
  };
}
