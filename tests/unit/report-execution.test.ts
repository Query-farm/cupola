import { expect, test } from "bun:test";
import { buildReportRunFailureNotice, classifyReportQueryError, isBlockingVegaWarning, validateReportResultColumns } from "../../src/lib/reports/execution";
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

test("reports missing sparkline value, label, and split columns", () => {
  const report = createEmptyReport("Weather");
  report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1" });
  report.blocks.push({
    id: "temperature",
    type: "sparkline",
    datasetId: "weather",
    valueColumn: "temperature",
    headlineValueColumn: "current_temperature",
    labelColumn: "observed_at",
    splitColumn: "is_forecast",
    layout: { x: 0, y: 0, w: 3, h: 2 },
  });
  expect(validateReportResultColumns(report, [{ datasetId: "weather", ok: true, columns: ["other"] }]))
    .toEqual(["temperature: missing result columns temperature, observed_at, is_forecast, current_temperature."]);
});

test("reports missing ranged KPI context columns", () => {
  const report = createEmptyReport("Humidity");
  report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1" });
  report.blocks.push({
    id: "humidity",
    type: "kpi",
    datasetId: "weather",
    valueColumn: "humidity",
    lowColumn: "preferred_low",
    highColumn: "preferred_high",
    targetColumn: "target",
    layout: { x: 0, y: 0, w: 3, h: 2 },
  });
  expect(validateReportResultColumns(report, [{ datasetId: "weather", ok: true, columns: ["humidity"] }]))
    .toEqual(["humidity: missing result columns preferred_low, preferred_high, target."]);
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

test("classifies an Open-Meteo 429 without leaking its worker stack", () => {
  const classified = classifyReportQueryError("Invalid Input Error: VGI Worker Exception: OpenMeteoError: Open-Meteo /v1/climate: HTTP 429: Minutely API request limit exceeded. Please try again in one minute. at omGet (cf.js:20923:11) at async handler (cf.js:14140:20) [worker: https://example.invalid/init/exchange]");
  expect(classified).toEqual({
    code: "rate_limited",
    message: "Open-Meteo is temporarily limiting requests. Try again in about 1 minute.",
    technicalDetails: "HTTP 429 from Open-Meteo: the request limit was exceeded.",
    retryable: true,
    retryAfterSeconds: 60,
    stopRun: true,
  });
});

test("summarizes a rate-limit circuit breaker without treating it as report validation", () => {
  const notice = buildReportRunFailureNotice([
    { name: "Climate normals", error: "Open-Meteo is temporarily limiting requests. Try again in about 1 minute.", errorDetails: "HTTP 429 from Open-Meteo: the request limit was exceeded.", errorCode: "rate_limited", retryAfterSeconds: 60, stale: true },
    { name: "Forecast", error: "Not refreshed because Climate normals hit a data-service rate limit.", errorCode: "blocked" },
  ], 2);
  expect(notice.title).toBe("Data refresh paused");
  expect(notice.message).toContain("1 remaining dataset was not requested");
  expect(notice.message).toContain("Previously loaded data remains visible");
  expect(notice.message).not.toContain("validation failed");
  expect(notice.details).toEqual([
    "Climate normals: HTTP 429 from Open-Meteo: the request limit was exceeded.",
    "Forecast: Not refreshed because Climate normals hit a data-service rate limit.",
  ]);
});
