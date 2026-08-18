import { describe, expect, test } from "bun:test";
import { compileChartSpec } from "../../src/components/chat/chart-embed";
import { validateReportResultColumns } from "../../src/lib/reports/execution";
import { createEmptyReport, type ReportBlock } from "../../src/lib/reports/types";
import { isReportTufteBlock, tufteBlockToVegaSpec } from "../../src/lib/reports/tufte";
import { validateReport } from "../../src/lib/reports/validation";

function blocks(): ReportBlock[] {
  return [{
    id: "multiples", type: "small_multiples", datasetId: "data", title: "Trends",
    facetColumn: "region", xColumn: "month", yColumn: "sales", xType: "temporal",
    referenceValue: 100, referenceLabel: "Goal", layout: { x: 0, y: 0, w: 12, h: 6 },
  }, {
    id: "bullet", type: "bullet", datasetId: "data", title: "Against plan",
    categoryColumn: "region", valueColumn: "sales", targetColumn: "target",
    rangeColumns: ["broad", "close"], layout: { x: 0, y: 6, w: 6, h: 5 },
  }, {
    id: "slope", type: "slopegraph", datasetId: "data", title: "Change",
    categoryColumn: "region", startColumn: "start_value", endColumn: "end_value",
    startLabel: "2025", endLabel: "2026", layout: { x: 6, y: 6, w: 6, h: 6 },
  }, {
    id: "range", type: "range_dot", datasetId: "data", title: "Range",
    categoryColumn: "region", lowColumn: "low", highColumn: "high", valueColumn: "sales",
    caption: "Dot is the current value.", source: "Planning model",
    layout: { x: 0, y: 12, w: 6, h: 5 },
  }];
}

describe("Tufte report blocks", () => {
  test("produce deterministic Vega-Lite specs that compile without dropped encodings", async () => {
    for (const block of blocks()) {
      expect(isReportTufteBlock(block)).toBe(true);
      if (!isReportTufteBlock(block)) continue;
      const result = await compileChartSpec(tufteBlockToVegaSpec(block));
      expect(result.error).toBeUndefined();
      expect(result.warnings.filter((warning) => /dropp|invalid|incompatible/i.test(warning))).toEqual([]);
    }
  });

  test("validates semantic fields, captions, sources, and live result columns", () => {
    const report = createEmptyReport("Comparisons");
    report.datasets.push({ id: "data", name: "Data", sql: "SELECT 1" });
    report.blocks.push(...blocks());
    expect(validateReport(report)).toEqual([]);
    expect(validateReportResultColumns(report, [{
      datasetId: "data",
      ok: true,
      columns: ["region", "month", "sales", "target", "broad", "close", "start_value", "end_value", "low"],
    }])).toEqual([
      "Range: missing result column high.",
    ]);
  });
});
