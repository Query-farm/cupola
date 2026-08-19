import { describe, expect, test } from "bun:test";
import { createReportShowcase } from "../../src/lib/reports/showcase";
import { validateReadOnlySql, validateReport } from "../../src/lib/reports/validation";

describe("built-in report block gallery", () => {
  test("is valid, catalog-free, and covers every report block type", () => {
    const report = createReportShowcase();

    expect(validateReport(report)).toEqual([]);
    expect(report.requiredSources).toEqual([]);
    expect(new Set(report.blocks.map((block) => block.type))).toEqual(new Set([
      "markdown",
      "ai_narrative",
      "kpi",
      "sparkline",
      "small_multiples",
      "bullet",
      "range_dot",
      "slopegraph",
      "table",
      "chart",
      "map",
      "perspective",
    ]));
    expect(report.datasets.every((dataset) => validateReadOnlySql(dataset.sql).length === 0)).toBe(true);
    expect(report.datasets.every((dataset) => /\b(?:VALUES|SELECT|WITH)\b/i.test(dataset.sql))).toBe(true);
    expect(report.blocks.find((block) => block.type === "ai_narrative")).toMatchObject({
      refreshPolicy: "manual",
      snapshot: { model: "example snapshot", rowCount: 1 },
    });
  });
});
