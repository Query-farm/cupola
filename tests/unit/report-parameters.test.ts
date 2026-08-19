import { describe, expect, test } from "bun:test";
import { compileReportQuery, interpolateReportText, materializeReportQuery } from "../../src/lib/reports/parameters";
import type { ReportParameter } from "../../src/lib/reports/types";

const parameters: ReportParameter[] = [
  { id: "p1", key: "region", label: "Region", type: "text", defaultValue: "East" },
  { id: "p2", key: "period", label: "Period", type: "date_range", defaultValue: { start: "2026-01-01", end: "2026-02-01" } },
  { id: "p3", key: "categories", label: "Categories", type: "multi_select", defaultValue: ["A", "B"] },
];

describe("compileReportQuery", () => {
  test("binds scalar, repeated, range, and list values in source order", () => {
    const result = compileReportQuery(
      "SELECT * FROM sales WHERE region = $region AND backup = $region AND day >= $period_start AND day < $period_end AND category IN ($categories)",
      { parameters },
      { region: "West", period: { start: "2026-03-01", end: "2026-04-01" }, categories: ["C", "D", "E"] },
    );
    expect(result.sql).toBe("SELECT * FROM sales WHERE region = ? AND backup = ? AND day >= ? AND day < ? AND category IN (?, ?, ?)");
    expect(result.params).toEqual(["West", "West", "2026-03-01", "2026-04-01", "C", "D", "E"]);
  });

  test("does not replace tokens inside strings, identifiers, comments, or dollar quotes", () => {
    const result = compileReportQuery(
      `SELECT '$region', "$region", $$ $region $$, $region -- $region\n/* $region */`,
      { parameters },
      { region: "West" },
    );
    expect(result.sql).toBe(`SELECT '$region', "$region", $$ $region $$, ? -- $region\n/* $region */`);
    expect(result.params).toEqual(["West"]);
  });

  test("expands an empty multi-select to NULL without bindings", () => {
    const result = compileReportQuery("SELECT 1 WHERE 'x' IN ($categories)", { parameters }, { categories: [] });
    expect(result.sql).toBe("SELECT 1 WHERE 'x' IN (NULL)");
    expect(result.params).toEqual([]);
  });
});

describe("materializeReportQuery", () => {
  test("opens a runnable SQL snapshot with safely escaped current values", () => {
    const parameters: any[] = [
      { id: "city", key: "city", label: "City", type: "text", defaultValue: "Glen Allen" },
      { id: "stations", key: "stations", label: "Stations", type: "multi_select", defaultValue: [] },
    ];
    expect(materializeReportQuery(
      "SELECT * FROM weather WHERE city = $city AND station IN ($stations)",
      { parameters },
      { city: "O'Hare", stations: ["A", "B"] },
    )).toBe("SELECT * FROM weather WHERE city = 'O''Hare' AND station IN ('A', 'B')");
  });

  test("does not replace parameter-looking text in strings or comments", () => {
    const parameters: any[] = [{ id: "value", key: "value", label: "Value", type: "number", defaultValue: 1 }];
    expect(materializeReportQuery("SELECT '$value' AS label, $value AS value -- $value", { parameters }, { value: 2 }))
      .toBe("SELECT '$value' AS label, 2 AS value -- $value");
  });
});

describe("interpolateReportText", () => {
  test("renders current scalar, list, and date-range values in display text", () => {
    expect(interpolateReportText(
      "48-Hour Forecast — $region · $period ($period_start to $period_end) · $categories",
      { parameters },
      { region: "Glen Allen", period: { start: "2026-08-19", end: "2026-08-21" }, categories: ["Weather", "Air quality"] },
    )).toBe("48-Hour Forecast — Glen Allen · 2026-08-19 – 2026-08-21 (2026-08-19 to 2026-08-21) · Weather, Air quality");
  });

  test("uses defaults and preserves unknown tokens", () => {
    expect(interpolateReportText("$region · $unknown", { parameters }, {})).toBe("East · $unknown");
  });
});
