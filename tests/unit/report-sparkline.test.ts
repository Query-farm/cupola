import { describe, expect, test } from "bun:test";
import { buildSparklineSeries, findSparklineSplit } from "../../src/lib/reports/sparkline";

describe("report sparkline series", () => {
  test("normalizes numeric values in query result order and keeps the latest row", () => {
    const rows = [{ day: "Mon", value: 10 }, { day: "Tue", value: null }, { day: "Wed", value: 30 }];
    const series = buildSparklineSeries(rows, "value");
    expect(series.data.map((datum) => datum.value)).toEqual([10, 30]);
    expect(series.points).toBe("0.00,30.00 100.00,2.00");
    expect(series.latest?.row.day).toBe("Wed");
  });

  test("centers a flat series and reports an empty nonnumeric series", () => {
    expect(buildSparklineSeries([{ value: 4 }, { value: 4 }], "value").points).toBe("0.00,16.00 100.00,16.00");
    expect(buildSparklineSeries([{ value: "unknown" }], "value").latest).toBeNull();
  });

  test("places a data-driven split between history and forecast points", () => {
    const series = buildSparklineSeries([
      { value: 10, phase: false },
      { value: 12, phase: false },
      { value: 14, phase: true },
      { value: 16, phase: true },
    ], "value");

    expect(findSparklineSplit(series, "phase")).toEqual({ index: 2, x: 50 });
    expect(findSparklineSplit(buildSparklineSeries([{ value: 1, phase: "forecast" }], "value"), "phase")).toEqual({ index: 0, x: 50 });
    expect(findSparklineSplit(series, "missing")).toBeNull();
  });
});
