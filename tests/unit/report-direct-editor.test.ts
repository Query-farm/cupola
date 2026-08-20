import { describe, expect, test } from "bun:test";
import { basicChartConfigFromSpec, basicChartSpec, createReportBlock, duplicateReportBlock } from "../../src/lib/reports/direct-editor";
import { createEmptyReport, type ReportBlock } from "../../src/lib/reports/types";

describe("report direct editor", () => {
  test("creates typed blocks with collision-free shared layout defaults", () => {
    const report = createEmptyReport("Editor");
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1 AS time, 2 AS value" });
    const kpi = createReportBlock(report, "kpi", "weather", ["time", "value"]);
    report.blocks.push(kpi);
    const chart = createReportBlock(report, "chart", "weather", ["time", "value"]);

    expect(kpi).toMatchObject({ type: "kpi", datasetId: "weather", valueColumn: "time", layout: { w: 3, h: 2 } });
    expect(chart).toMatchObject({ type: "chart", datasetId: "weather", layout: { w: 12, h: 6 } });
    expect(chart.layout.y).toBeGreaterThanOrEqual(kpi.layout.y + kpi.layout.h);
  });

  test("round trips common chart settings as ordinary Vega-Lite", () => {
    const config = {
      mark: "bar" as const,
      xField: "day", xType: "temporal" as const, xAggregate: "none" as const, xTitle: "Day",
      yField: "sales", yType: "quantitative" as const, yAggregate: "sum" as const, yTitle: "Sales",
      colorField: "region", fixedColor: "", facetRow: "", facetColumn: "store",
      legend: true, legendTitle: "Region", zero: "include" as const, palette: "tableau10",
    };
    const spec = basicChartSpec(config);
    expect(basicChartConfigFromSpec(spec)).toEqual(config);
    expect(spec).not.toHaveProperty("data");
    expect(spec.encoding.tooltip).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "day", type: "temporal" }),
      expect.objectContaining({ field: "sales", aggregate: "sum" }),
      expect.objectContaining({ field: "region", type: "nominal", title: "Region" }),
    ]));
  });

  test("keeps advanced composed charts in advanced mode", () => {
    expect(basicChartConfigFromSpec({ layer: [{ mark: "line" }] })).toBeNull();
  });

  test("keeps lossy simple Vega-Lite specs in advanced mode", () => {
    expect(basicChartConfigFromSpec({
      title: "Temperature",
      mark: { type: "line", point: true, strokeWidth: 3 },
      encoding: {
        x: { field: "time", type: "temporal", axis: { format: "%H:%M" } },
        y: { field: "value", type: "quantitative", scale: { domain: [60, 80] } },
        tooltip: [{ field: "value", format: ".1f" }],
      },
      config: { view: { stroke: null } },
    })).toBeNull();
  });

  test("duplicates configuration while assigning identity and placement", () => {
    const report = createEmptyReport("Editor");
    const source: ReportBlock = { id: "kpi", type: "kpi", title: "Humidity", datasetId: "weather", valueColumn: "humidity", layout: { x: 0, y: 0, w: 3, h: 2 } };
    report.blocks.push(source);
    const copy = duplicateReportBlock(report, source);
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({ type: "kpi", title: "Copy of Humidity", datasetId: "weather", valueColumn: "humidity" });
    expect(copy.layout).not.toEqual(source.layout);
  });
});
