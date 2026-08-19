import { describe, expect, test } from "bun:test";
import { readableChartConfig } from "../../src/components/chat/chart-embed";

describe("readableChartConfig", () => {
  test("adds readable legend defaults without discarding other chart config", () => {
    expect(readableChartConfig({ axis: { grid: false }, legend: { orient: "bottom" } }, "transparent")).toEqual({
      axis: { grid: false },
      legend: { labelFontSize: 12, titleFontSize: 13, orient: "bottom" },
      background: "transparent",
    });
  });

  test("preserves deliberate legend sizes and disabled legends", () => {
    expect(readableChartConfig({ legend: { labelFontSize: 16, titleFontSize: 18 } }, "white").legend).toEqual({
      labelFontSize: 16,
      titleFontSize: 18,
    });
    expect(readableChartConfig({ legend: null }, "white").legend).toBeNull();
  });
});
