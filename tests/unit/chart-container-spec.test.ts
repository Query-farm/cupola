/**
 * Tests for isContainerSpec in chart-embed.ts.
 *
 * Vega-Lite ignores top-level autosize:"fit" and width:"container" on
 * faceted, repeated, and concat/hconcat/vconcat views (documented
 * limitation). Detection lets the embed pipeline skip those overrides
 * for container specs so the LLM's per-unit sizing actually takes
 * effect. A regression here would re-break faceted charts.
 */
import { test, expect, describe, mock } from "bun:test";

// Stub the service chain so this unit test doesn't pull the VGI/RPC
// graph through the chart-embed import.
mock.module("@query-farm/vgi-rpc/connect", () => ({ httpConnect: () => { throw new Error("stub"); } }));

const { isContainerSpec } = await import("../../src/components/chat/chart-embed");

describe("isContainerSpec", () => {
  test("plain unit spec → false", () => {
    expect(isContainerSpec({ mark: "bar", encoding: { x: { field: "a" }, y: { field: "b" } } })).toBe(false);
  });

  test("layered spec → false (layer supports autosize:fit)", () => {
    expect(isContainerSpec({ layer: [{ mark: "circle" }, { mark: "line" }] })).toBe(false);
  });

  test("explicit facet operator → true", () => {
    expect(isContainerSpec({ facet: { row: { field: "x" } }, spec: { mark: "bar" } })).toBe(true);
  });

  test("repeat → true", () => {
    expect(isContainerSpec({ repeat: ["a", "b", "c"], spec: { mark: "line" } })).toBe(true);
  });

  test("concat / hconcat / vconcat → true", () => {
    expect(isContainerSpec({ concat: [{}, {}] })).toBe(true);
    expect(isContainerSpec({ hconcat: [{}, {}] })).toBe(true);
    expect(isContainerSpec({ vconcat: [{}, {}] })).toBe(true);
  });

  test("implicit facet via encoding.row → true", () => {
    expect(isContainerSpec({
      mark: "bar",
      encoding: { x: { field: "a" }, y: { field: "b" }, row: { field: "c" } },
    })).toBe(true);
  });

  test("implicit facet via encoding.column → true", () => {
    expect(isContainerSpec({
      mark: "bar",
      encoding: { x: { field: "a" }, y: { field: "b" }, column: { field: "c" } },
    })).toBe(true);
  });

  test("encoding without row/column → false", () => {
    expect(isContainerSpec({
      mark: "bar",
      encoding: { x: { field: "a" }, y: { field: "b" }, color: { field: "c" } },
    })).toBe(false);
  });

  test("missing encoding object → false", () => {
    expect(isContainerSpec({ mark: "bar" })).toBe(false);
  });
});
