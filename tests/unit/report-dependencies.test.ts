import { describe, expect, test } from "bun:test";
import { buildReportDatasetExecutionPlan, inferReportDatasetDependencies, quoteReportDatasetIdentifier } from "../../src/lib/reports/dependencies";
import type { ReportDataset } from "../../src/lib/reports/types";

const datasets: ReportDataset[] = [
  { id: "weather_base", name: "Weather source", sql: "SELECT * FROM open_meteo()" },
  { id: "current_conditions", name: "Current conditions", sql: "SELECT * FROM weather_base ORDER BY observed_at DESC LIMIT 1" },
  { id: "forecast", name: "Forecast", sql: "SELECT * FROM weather_base WHERE is_forecast" },
  { id: "summary", name: "Summary", sql: "SELECT count(*) AS hours FROM forecast" },
];

const parsed: Record<string, string[]> = {
  "SELECT * FROM open_meteo()": [],
  "SELECT * FROM weather_base ORDER BY observed_at DESC LIMIT 1": ["weather_base"],
  "SELECT * FROM weather_base WHERE is_forecast": ["weather_base"],
  "SELECT count(*) AS hours FROM forecast": ["forecast"],
};

describe("report dataset dependency planning", () => {
  test("infers relations with DuckDB's parser and orders dependencies first", async () => {
    const dependencies = await inferReportDatasetDependencies(datasets, async (sql) => parsed[sql] ?? []);
    const plan = buildReportDatasetExecutionPlan(datasets, dependencies);

    expect([...dependencies.get("current_conditions")!]).toEqual(["weather_base"]);
    expect([...dependencies.get("summary")!]).toEqual(["forecast"]);
    expect(plan.datasets.map((dataset) => dataset.id)).toEqual(["weather_base", "current_conditions", "forecast", "summary"]);
    expect([...plan.materialized]).toEqual(["weather_base", "forecast"]);
  });

  test("adds ancestors for a targeted run", async () => {
    const dependencies = await inferReportDatasetDependencies(datasets, async (sql) => parsed[sql] ?? []);
    const plan = buildReportDatasetExecutionPlan(datasets, dependencies, new Set(["summary"]));
    expect(plan.datasets.map((dataset) => dataset.id)).toEqual(["weather_base", "forecast", "summary"]);
    expect([...plan.materialized]).toEqual(["weather_base", "forecast"]);
  });

  test("adds downstream consumers when an upstream parameter changes", async () => {
    const dependencies = await inferReportDatasetDependencies(datasets, async (sql) => parsed[sql] ?? []);
    const plan = buildReportDatasetExecutionPlan(datasets, dependencies, new Set(["weather_base"]), true);
    expect(plan.datasets.map((dataset) => dataset.id)).toEqual(["weather_base", "current_conditions", "forecast", "summary"]);
  });

  test("treats a matching self-reference as an external source", async () => {
    const source = [{ id: "weather", name: "Weather", sql: "SELECT * FROM weather" }];
    const dependencies = await inferReportDatasetDependencies(source, async () => ["weather"]);
    expect([...dependencies.get("weather")!]).toEqual([]);
  });

  test("detects dependency cycles", () => {
    const cyclic = [
      { id: "a", name: "A", sql: "SELECT * FROM b" },
      { id: "b", name: "B", sql: "SELECT * FROM a" },
    ];
    const dependencies = new Map([["a", new Set(["b"])], ["b", new Set(["a"])]]);
    expect(() => buildReportDatasetExecutionPlan(cyclic, dependencies)).toThrow("a → b → a");
  });

  test("quotes generated temporary relation names", () => {
    expect(quoteReportDatasetIdentifier('weather "shared"')).toBe('"weather ""shared"""');
  });
});
