import { describe, expect, test } from "bun:test";
import { normalizeReportLayout, reflowReportLayout, reportLayoutCollisions } from "../../src/lib/reports/layout";
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

  test("reflows blocks upward into the earliest collision-free rows", () => {
    const report = createEmptyReport("Gaps");
    report.blocks.push(
      { id: "left", type: "markdown", markdown: "Left", layout: { x: 0, y: 5, w: 6, h: 2 } },
      { id: "right", type: "markdown", markdown: "Right", layout: { x: 6, y: 8, w: 6, h: 3 } },
      { id: "footer", type: "markdown", markdown: "Footer", layout: { x: 0, y: 14, w: 12, h: 2 } },
    );

    const reflowed = reflowReportLayout(report);

    expect(reflowed.blocks.map((block) => block.layout)).toEqual([
      { x: 0, y: 0, w: 6, h: 2 },
      { x: 6, y: 0, w: 6, h: 3 },
      { x: 0, y: 3, w: 12, h: 2 },
    ]);
    expect(reportLayoutCollisions(reflowed.blocks)).toEqual([]);
    expect(reflowReportLayout(reflowed)).toBe(reflowed);
  });

  test("keeps groups bounded and reserves a row for stacked group headings", () => {
    const report = createEmptyReport("Grouped gaps");
    report.groups = [
      { id: "observed", title: "Observed" },
      { id: "forecast", title: "Forecast" },
    ];
    report.blocks.push(
      { id: "observed-a", groupId: "observed", type: "markdown", markdown: "A", layout: { x: 0, y: 4, w: 6, h: 2 } },
      { id: "observed-b", groupId: "observed", type: "markdown", markdown: "B", layout: { x: 6, y: 6, w: 6, h: 2 } },
      { id: "forecast-a", groupId: "forecast", type: "markdown", markdown: "C", layout: { x: 0, y: 20, w: 6, h: 3 } },
      { id: "forecast-b", groupId: "forecast", type: "markdown", markdown: "D", layout: { x: 6, y: 20, w: 6, h: 3 } },
    );

    const reflowed = reflowReportLayout(report);

    expect(reflowed.blocks.map((block) => block.layout)).toEqual([
      { x: 0, y: 0, w: 6, h: 2 },
      { x: 6, y: 0, w: 6, h: 2 },
      { x: 0, y: 3, w: 6, h: 3 },
      { x: 6, y: 3, w: 6, h: 3 },
    ]);
    expect(reportLayoutCollisions(reflowed.blocks)).toEqual([]);
  });
});
