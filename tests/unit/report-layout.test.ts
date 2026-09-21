import { describe, expect, test } from "bun:test";
import { cloneLayout, getLayoutItem, moveElement, type Layout } from "react-grid-layout/core";
import { createReportGridCompactor } from "../../src/lib/reports/grid-compactor";
import { normalizeReportLayout, reflowReportLayout, reportDragLayout, reportLayoutCollisions, reportLayoutsOverlap, type ReportGridItem } from "../../src/lib/reports/layout";
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

function rows(layout: readonly ReportGridItem[]): Record<string, number> {
  return Object.fromEntries(layout.map((item) => [item.i, item.y]));
}

function expectNoOverlap(layout: readonly ReportGridItem[]) {
  for (let first = 0; first < layout.length; first++) {
    for (let second = first + 1; second < layout.length; second++) {
      expect(reportLayoutsOverlap(layout[first], layout[second])).toBe(false);
    }
  }
}

// Full-width blocks, stacked: the shape where reordering was hardest.
const STACK: ReportGridItem[] = [
  { i: "a", x: 0, y: 0, w: 12, h: 6 },
  { i: "b", x: 0, y: 6, w: 12, h: 5 },
  { i: "c", x: 0, y: 11, w: 12, h: 4 },
];

describe("report drag layout", () => {
  test("a block dragged down passes a neighbor once nearer its far side", () => {
    // Slots for "a": above b (row 0) or below b (row 5). Row 2 is nearer 0.
    expect(rows(reportDragLayout(STACK, "a", { x: 0, y: 2 }))).toEqual({ a: 0, b: 6, c: 11 });
    expect(rows(reportDragLayout(STACK, "a", { x: 0, y: 3 }))).toEqual({ a: 5, b: 0, c: 11 });
    expect(rows(reportDragLayout(STACK, "a", { x: 0, y: 8 }))).toEqual({ a: 9, b: 0, c: 5 });
  });

  test("a block dragged up passes each neighbor it crosses", () => {
    // Slots for "c": below b (row 11) or above it (row 6); row 9 is nearer 11.
    expect(rows(reportDragLayout(STACK, "c", { x: 0, y: 9 }))).toEqual({ a: 0, b: 6, c: 11 });
    expect(rows(reportDragLayout(STACK, "c", { x: 0, y: 8 }))).toEqual({ a: 0, b: 10, c: 6 });
    expect(rows(reportDragLayout(STACK, "c", { x: 0, y: 1 }))).toEqual({ a: 4, b: 10, c: 0 });
  });

  test("equidistant slots keep the one nearest the block's original slot", () => {
    // Row 7 is two rows from both "below b" (5) and "below c" (9).
    expect(rows(reportDragLayout(STACK, "a", { x: 0, y: 7 }))).toEqual({ a: 5, b: 0, c: 11 });
  });

  test("an untouched drag reproduces the layout, gaps included", () => {
    const gapped: ReportGridItem[] = [
      { i: "a", x: 0, y: 0, w: 6, h: 3 },
      { i: "b", x: 6, y: 2, w: 6, h: 3 },
      { i: "c", x: 0, y: 8, w: 12, h: 4 },
    ];
    for (const item of gapped) {
      expect(reportDragLayout(gapped, item.i, { x: item.x, y: item.y })).toEqual(gapped);
    }
  });

  test("blocks outside the dragged block's path keep their deliberate space", () => {
    const gapped: ReportGridItem[] = [
      { i: "top", x: 0, y: 0, w: 12, h: 2 },
      { i: "left", x: 0, y: 2, w: 6, h: 4 },
      { i: "right", x: 6, y: 4, w: 6, h: 2 },
      { i: "last", x: 0, y: 6, w: 6, h: 2 },
    ];
    // "last" moves above "left"; "right" is in other columns and stays put.
    const moved = reportDragLayout(gapped, "last", { x: 0, y: 2 });
    expect(rows(moved)).toEqual({ top: 0, left: 4, right: 4, last: 2 });
    expectNoOverlap(moved);
  });

  test("a full-width block passes a row of side-by-side blocks as a unit", () => {
    const layout: ReportGridItem[] = [
      { i: "wide", x: 0, y: 0, w: 12, h: 3 },
      { i: "left", x: 0, y: 3, w: 6, h: 4 },
      { i: "right", x: 6, y: 3, w: 6, h: 4 },
    ];
    const moved = reportDragLayout(layout, "wide", { x: 0, y: 3 });
    expect(rows(moved)).toEqual({ wide: 4, left: 0, right: 0 });
    expectNoOverlap(moved);
  });

  test("a block can move into free columns of an earlier row", () => {
    const layout: ReportGridItem[] = [
      { i: "left", x: 0, y: 0, w: 6, h: 4 },
      { i: "wide", x: 0, y: 4, w: 12, h: 3 },
      { i: "kpi", x: 0, y: 7, w: 6, h: 2 },
    ];
    const moved = reportDragLayout(layout, "kpi", { x: 6, y: 0 });
    expect(moved.find((item) => item.i === "kpi")).toMatchObject({ x: 6, y: 0 });
    expect(rows(moved)).toEqual({ left: 0, wide: 4, kpi: 0 });
  });

  test("reordering inside a group keeps heading rows at section starts", () => {
    const groupOf = (id: string) => ({ o1: "observed", o2: "observed", f1: "forecast", f2: "forecast" } as Record<string, string>)[id];
    const layout: ReportGridItem[] = [
      { i: "intro", x: 0, y: 0, w: 12, h: 2 },
      { i: "o1", x: 0, y: 3, w: 12, h: 4 },
      { i: "o2", x: 0, y: 7, w: 12, h: 3 },
      { i: "f1", x: 0, y: 11, w: 12, h: 5 },
      { i: "f2", x: 0, y: 16, w: 12, h: 3 },
    ];
    // f2 moves to the top of the forecast section and takes its heading row.
    const moved = reportDragLayout(layout, "f2", { x: 0, y: 11 }, groupOf);
    expect(rows(moved)).toEqual({ intro: 0, o1: 3, o2: 7, f2: 11, f1: 14 });
    expectNoOverlap(moved);
    // The first member moving down hands the heading row to the next one.
    expect(rows(reportDragLayout(layout, "o1", { x: 0, y: 6 }, groupOf))).toEqual({ intro: 0, o2: 3, o1: 6, f1: 11, f2: 16 });
  });

  test("never produces overlapping blocks", () => {
    const layout: ReportGridItem[] = [
      { i: "a", x: 0, y: 0, w: 4, h: 2 },
      { i: "b", x: 4, y: 0, w: 4, h: 5 },
      { i: "c", x: 8, y: 0, w: 4, h: 3 },
      { i: "d", x: 0, y: 2, w: 8, h: 4 },
      { i: "e", x: 6, y: 6, w: 6, h: 2 },
      { i: "f", x: 0, y: 8, w: 12, h: 3 },
    ];
    for (const item of layout) {
      for (let x = 0; x <= 12 - item.w; x += 2) {
        for (let y = 0; y <= 14; y++) expectNoOverlap(reportDragLayout(layout, item.i, { x, y }));
      }
    }
  });
});

describe("report grid compactor", () => {
  // Replays react-grid-layout's own drag step (moveElement, then compact) for
  // each pointer row, exactly as its GridLayout.onDrag does.
  function drag(grouped: boolean, start: Layout, id: string, pointerRows: number[]): Record<string, number> {
    const compactor = createReportGridCompactor(grouped, () => undefined);
    let layout = compactor.compact(cloneLayout(start), 12);
    compactor.startDrag(layout, id);
    for (const y of pointerRows) {
      const item = getLayoutItem(layout, id)!;
      const moved = moveElement(layout, item, item.x, y, true, false, compactor.type, 12, compactor.allowOverlap);
      layout = compactor.compact(moved, 12);
    }
    compactor.endDrag();
    return rows(layout);
  }

  test("a block dragged down passes its neighbor in a grouped report", () => {
    // Previously the neighbor was shoved ahead of the block on every step.
    expect(drag(true, STACK, "a", [1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ a: 9, b: 0, c: 5 });
  });

  test("a block dragged down passes its neighbor after half its height", () => {
    // Previously this needed the neighbor's full height (row 5).
    expect(drag(false, STACK, "a", [1, 2, 3])).toEqual({ a: 5, b: 0, c: 11 });
  });

  test("a block dragged up passes its neighbors in a grouped report", () => {
    expect(drag(true, STACK, "c", [10, 8, 6, 4, 2, 1])).toEqual({ a: 4, b: 10, c: 0 });
  });

  test("outside a drag it compacts exactly as before", () => {
    const gapped: Layout = [
      { i: "a", x: 0, y: 2, w: 12, h: 2 },
      { i: "b", x: 0, y: 7, w: 12, h: 2 },
    ];
    expect(rows(createReportGridCompactor(true, () => undefined).compact(gapped, 12))).toEqual({ a: 2, b: 7 });
    expect(rows(createReportGridCompactor(false, () => undefined).compact(gapped, 12))).toEqual({ a: 0, b: 2 });
  });
});
