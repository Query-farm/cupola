import { expect, test } from "bun:test";
import { isBlockingVegaWarning, validateReportResultColumns } from "../../src/lib/reports/execution";
import { createEmptyReport } from "../../src/lib/reports/types";

test("reports missing map columns after dataset execution", () => {
  const report = createEmptyReport("Locations");
  report.datasets.push({ id: "locations", name: "Locations", sql: "SELECT name, latitude FROM locations" });
  report.blocks.push({
    id: "map",
    type: "map",
    datasetId: "locations",
    title: "Office map",
    latitudeColumn: "latitude",
    longitudeColumn: "longitude",
    labelColumn: "name",
    tooltipColumns: ["name", "status"],
    layout: { x: 0, y: 0, w: 12, h: 6 },
  });

  expect(validateReportResultColumns(report, [{
    datasetId: "locations",
    ok: true,
    columns: ["name", "latitude"],
  }])).toEqual(["Office map: missing result columns longitude, status."]);
});

test("requires correction for silently dropped Vega encodings", () => {
  expect(isBlockingVegaWarning('Dropping "high" from channel "y2" since it does not contain any data field.')).toBe(true);
  expect(isBlockingVegaWarning("shape dropped as it is incompatible with circle")).toBe(true);
  expect(isBlockingVegaWarning("Log scale domain includes zero: [0, 10]")).toBe(false);
});

test("reports missing sparkline value and label columns", () => {
  const report = createEmptyReport("Weather");
  report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1" });
  report.blocks.push({
    id: "temperature",
    type: "sparkline",
    datasetId: "weather",
    valueColumn: "temperature",
    labelColumn: "observed_at",
    layout: { x: 0, y: 0, w: 3, h: 2 },
  });
  expect(validateReportResultColumns(report, [{ datasetId: "weather", ok: true, columns: ["other"] }]))
    .toEqual(["temperature: missing result columns temperature, observed_at."]);
});

test("validates appearance rule columns for free-form charts", () => {
  const report = createEmptyReport("Alerts");
  report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1" });
  report.blocks.push({
    id: "trend",
    type: "chart",
    datasetId: "weather",
    spec: { mark: "line" },
    appearance: { rules: [{ column: "alert_level", operator: "equal", value: "high", tone: "danger", label: "High alert" }] },
    layout: { x: 0, y: 0, w: 12, h: 6 },
  });
  expect(validateReportResultColumns(report, [{ datasetId: "weather", ok: true, columns: ["value"] }]))
    .toEqual(["trend: missing result column alert_level."]);
});

test("reports missing columns selected for an AI narrative", () => {
  const report = createEmptyReport("Weather summary");
  report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT temperature FROM weather" });
  report.blocks.push({
    id: "summary",
    type: "ai_narrative",
    title: "Conditions summary",
    datasetId: "weather",
    instruction: "Summarize the conditions.",
    columns: ["temperature", "humidity"],
    layout: { x: 0, y: 0, w: 12, h: 4 },
  });
  expect(validateReportResultColumns(report, [{ datasetId: "weather", ok: true, columns: ["temperature"] }]))
    .toEqual(["Conditions summary: missing result column humidity."]);
});
