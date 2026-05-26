/**
 * Tests for the Mosaic semantic linter. Targets the runtime-crash class
 * the JSON-schema validator can't catch: continuous-axis interactors
 * (intervalX/Y/XY, panZoom) attached to plots whose mark forces a
 * categorical axis (barX, barY, cell, cellX, cellY).
 *
 * Each test mirrors a real spec the agent has shipped or is likely to
 * ship. The lint runs without DB queries, so all assertions are purely
 * structural — column types are not consulted.
 */
import { test, expect } from "bun:test";
import { lintMosaicSpec, lintMosaicSpecWithTypes, formatLintIssues } from "../../src/lib/mosaic-lint";
import { tableToIPC, tableFromArrays } from "@uwdata/flechette";

test("intervalX on a barY chart is flagged", () => {
  const spec = {
    plot: [
      { mark: "barY", data: { from: "t" }, x: "cat", y: "n" },
      { select: "intervalX", as: "$brush" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(1);
  expect(issues[0].path).toBe("/plot/1");
  expect(issues[0].severity).toBe("error");
  expect(issues[0].selector).toBe("intervalX");
  expect(issues[0].message).toContain("toggleX");
  expect(issues[0].message).toContain("barY");
});

test("intervalY on a barX chart is flagged", () => {
  const spec = {
    plot: [
      { mark: "barX", data: { from: "t" }, x: "n", y: "cat" },
      { select: "intervalY", as: "$brush" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(1);
  expect(issues[0].message).toContain("toggleY");
});

test("intervalXY on a barY chart flags the X axis only and recommends intervalY or toggleX", () => {
  const spec = {
    plot: [
      { mark: "barY", x: "cat", y: "n" },
      { select: "intervalXY", as: "$brush" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(1);
  expect(issues[0].message).toMatch(/intervalY|toggleX/);
});

test("intervalXY on a cell chart flags BOTH axes and recommends toggle", () => {
  const spec = {
    plot: [
      { mark: "cell", x: "rowCat", y: "colCat", fill: "n" },
      { select: "intervalXY", as: "$brush" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(1);
  // Message should explicitly recommend the discrete toggle.
  expect(issues[0].message).toContain('toggle');
});

test("toggleX on a barY chart is NOT flagged (correct pairing)", () => {
  const spec = {
    plot: [
      { mark: "barY", x: "cat", y: "n" },
      { select: "toggleX", as: "$brush" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(0);
});

test("intervalX on a dot/line chart is NOT flagged (axis types unknown — could be valid)", () => {
  // The linter intentionally doesn't flag free-form marks whose axis types
  // depend on data. The agent gets a clean pass; if the data actually IS
  // categorical, the render-time crash is caught by Mosaic itself.
  const spec = {
    plot: [
      { mark: "dot", x: "x", y: "y" },
      { select: "intervalX", as: "$brush" },
    ],
  };
  expect(lintMosaicSpec(spec)).toHaveLength(0);
});

test("recurses into vconcat / hconcat layouts", () => {
  const spec = {
    vconcat: [
      {
        plot: [
          { mark: "barY", x: "cat", y: "n" },
          { select: "intervalX", as: "$brush" },
        ],
      },
      {
        hconcat: [
          {
            plot: [
              { mark: "cell", x: "a", y: "b" },
              { select: "intervalXY", as: "$brush" },
            ],
          },
        ],
      },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(2);
  expect(issues[0].path).toBe("/vconcat/0/plot/1");
  expect(issues[1].path).toBe("/vconcat/1/hconcat/0/plot/1");
});

test("multiple marks in one plot: ANY categorical mark wins for that axis", () => {
  // A dot overlay on top of a bar chart — the bar still forces X to be
  // categorical, so an intervalX brush is still invalid for the plot.
  const spec = {
    plot: [
      { mark: "barY", x: "cat", y: "n" },
      { mark: "dot", x: "cat", y: "n" },
      { select: "intervalX", as: "$brush" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(1);
  expect(issues[0].path).toBe("/plot/2");
});

test("panZoom on a barY chart is flagged", () => {
  const spec = {
    plot: [
      { mark: "barY", x: "cat", y: "n" },
      { select: "panZoom" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(1);
  expect(issues[0].selector).toBe("panZoom");
  expect(issues[0].message).toMatch(/pan|zoom/i);
});

test("type-aware lint flags intervalXY on a `dot` chart with a string Y column", async () => {
  // Mirrors the exact production crash: free-form mark, mark-based heuristic
  // doesn't fire, but the Y column is a string → categorical scale →
  // intervalXY tries to .invert on a band scale → crash. The type pass
  // catches it via DESCRIBE.
  const spec = {
    data: { departures: "SELECT total_minutes, track FROM trains.main.station_departures" },
    plot: [
      { mark: "circle", data: { from: "departures" }, x: "total_minutes", y: "track" },
      { select: "intervalXY", as: "$brush" },
    ],
  };

  // Mock runQuery returns an Arrow IPC buffer mimicking DuckDB's DESCRIBE
  // result shape (column_name, column_type, ...). Only the first two cols
  // are inspected by the linter.
  const runQuery = async (sql: string) => {
    if (!sql.startsWith("DESCRIBE")) return { ok: false, error: "unexpected sql" };
    const table = tableFromArrays({
      column_name: ["total_minutes", "track"],
      column_type: ["BIGINT", "VARCHAR"],
    });
    return { ok: true, arrowBuffers: [tableToIPC(table, { format: "file" })] };
  };

  const issues = await lintMosaicSpecWithTypes(spec, runQuery);
  expect(issues.length).toBeGreaterThan(0);
  const e = issues.find((i) => i.selector === "intervalXY");
  expect(e).toBeDefined();
  expect(e!.message).toContain("track");
  expect(e!.message).toContain("VARCHAR");
});

test("type-aware lint does NOT flag intervalXY when both columns are numeric", async () => {
  const spec = {
    data: { d: "SELECT x, y FROM t" },
    plot: [
      { mark: "circle", data: { from: "d" }, x: "x", y: "y" },
      { select: "intervalXY", as: "$brush" },
    ],
  };
  const runQuery = async (sql: string) => {
    if (!sql.startsWith("DESCRIBE")) return { ok: false, error: "unexpected" };
    const table = tableFromArrays({
      column_name: ["x", "y"],
      column_type: ["DOUBLE", "DOUBLE"],
    });
    return { ok: true, arrowBuffers: [tableToIPC(table, { format: "file" })] };
  };
  const issues = await lintMosaicSpecWithTypes(spec, runQuery);
  expect(issues).toHaveLength(0);
});

test("type-aware lint degrades gracefully when DESCRIBE fails", async () => {
  const spec = {
    data: { d: "INVALID SQL" },
    plot: [
      { mark: "circle", data: { from: "d" }, x: "x", y: "y" },
      { select: "intervalXY", as: "$brush" },
    ],
  };
  const runQuery = async () => ({ ok: false, error: "syntax error" });
  // No mark-based flag and DESCRIBE fails → graceful empty result (the
  // full pre-render will surface the real SQL error).
  const issues = await lintMosaicSpecWithTypes(spec, runQuery);
  expect(issues).toHaveLength(0);
});

test("intervalX + intervalY on same plot writing to same selection is flagged", () => {
  // The recurring antipattern: agent wires up two 1D brushes hoping they'll
  // compose into a 2D brush. They don't — D3 brushes fight for pointer
  // events on the same SVG. The right thing is `intervalXY`.
  const spec = {
    plot: [
      { mark: "circle", data: { from: "eq" }, x: "lon", y: "lat" },
      { select: "intervalX", as: "$brush" },
      { select: "intervalY", as: "$brush" },
    ],
  };
  const issues = lintMosaicSpec(spec);
  expect(issues).toHaveLength(1);
  expect(issues[0].selector).toBe("intervalX");
  expect(issues[0].message).toContain("intervalXY");
  expect(issues[0].message).toContain("$brush");
});

test("intervalX + intervalY on same plot to DIFFERENT selections is NOT flagged", () => {
  // Independent selections — perfectly valid.
  const spec = {
    plot: [
      { mark: "circle", data: { from: "eq" }, x: "lon", y: "lat" },
      { select: "intervalX", as: "$brushX" },
      { select: "intervalY", as: "$brushY" },
    ],
  };
  expect(lintMosaicSpec(spec)).toHaveLength(0);
});

test("formatLintIssues produces a path-prefixed multi-line string", () => {
  const spec = {
    plot: [
      { mark: "barY", x: "cat", y: "n" },
      { select: "intervalX", as: "$brush" },
    ],
  };
  const text = formatLintIssues(lintMosaicSpec(spec));
  expect(text).toContain("/plot/1:");
  expect(text).toContain("intervalX");
});
