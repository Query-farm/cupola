import { describe, expect, test } from "bun:test";
import { normalizeReportLayout, reportLayoutCollisions } from "../../src/lib/reports/layout";
import { createEmptyReport } from "../../src/lib/reports/types";
import { validateReport } from "../../src/lib/reports/validation";

describe("report layout normalization", () => {
  test("reports collisions with both block names", () => {
    const report = createEmptyReport("Collision");
    report.blocks.push(
      { id: "humidity", type: "markdown", title: "Humidity", markdown: "68%", layout: { x: 0, y: 0, w: 4, h: 3 } },
      { id: "forecast", type: "markdown", title: "Forecast", markdown: "Rain", layout: { x: 3, y: 2, w: 6, h: 3 } },
    );

    expect(validateReport(report)).toContain("Blocks “Humidity” and “Forecast” overlap in the report layout.");
  });

  test("keeps the directly edited block fixed and moves colliding neighbors downward", () => {
    const report = createEmptyReport("Reflow");
    report.blocks.push(
      { id: "humidity", type: "markdown", title: "Humidity", markdown: "68%", layout: { x: 0, y: 3, w: 3, h: 6 } },
      { id: "trend", type: "markdown", title: "Trend", markdown: "Chart", layout: { x: 0, y: 7, w: 7, h: 5 } },
      { id: "summary", type: "markdown", title: "Summary", markdown: "Text", layout: { x: 7, y: 7, w: 5, h: 5 } },
    );

    const normalized = normalizeReportLayout(report, "humidity");

    expect(normalized.blocks.find((block) => block.id === "humidity")?.layout).toEqual({ x: 0, y: 3, w: 3, h: 6 });
    expect(normalized.blocks.find((block) => block.id === "trend")?.layout).toEqual({ x: 0, y: 9, w: 7, h: 5 });
    expect(normalized.blocks.find((block) => block.id === "summary")?.layout).toEqual({ x: 7, y: 7, w: 5, h: 5 });
    expect(reportLayoutCollisions(normalized.blocks)).toEqual([]);
    expect(validateReport(normalized)).toEqual([]);
  });

  test("normalizes a bulk layout deterministically without changing block dimensions", () => {
    const report = createEmptyReport("Imported layout");
    report.blocks.push(
      { id: "a", type: "markdown", markdown: "A", layout: { x: 0, y: 0, w: 12, h: 2 } },
      { id: "b", type: "markdown", markdown: "B", layout: { x: 0, y: 1, w: 6, h: 4 } },
      { id: "c", type: "markdown", markdown: "C", layout: { x: 0, y: 3, w: 6, h: 2 } },
    );

    const normalized = normalizeReportLayout(report);

    expect(normalized.blocks.map((block) => block.layout)).toEqual([
      { x: 0, y: 0, w: 12, h: 2 },
      { x: 0, y: 2, w: 6, h: 4 },
      { x: 0, y: 6, w: 6, h: 2 },
    ]);
    expect(reportLayoutCollisions(normalized.blocks)).toEqual([]);
  });
});
