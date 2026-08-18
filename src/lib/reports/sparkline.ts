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
