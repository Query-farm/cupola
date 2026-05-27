/**
 * Tests for validateExtraData in src/lib/ai-tool-executor.ts.
 *
 * extraData is the multi-source render_chart parameter. Each entry must
 * have a unique, name-pattern-matching name (not the reserved
 * __cupola_data) and a non-empty SQL string. Cap at 5 entries to defend
 * against runaway agent loops.
 *
 * These rules are the gate between the LLM and the chart pipeline — a
 * regression here would let bad inputs reach the cache + embed and
 * potentially crash the chart with a "Duplicate data set name" or
 * worse.
 */
import { test, expect, describe, mock } from "bun:test";

mock.module("@query-farm/vgi-rpc/connect", () => ({ httpConnect: () => { throw new Error("stub"); } }));

const { validateExtraData } = await import("../../src/lib/ai-tool-executor");

describe("validateExtraData", () => {
  test("undefined / null / [] returns empty cleaned with no errors", () => {
    expect(validateExtraData(undefined)).toEqual({ errors: [], cleaned: [] });
    expect(validateExtraData(null)).toEqual({ errors: [], cleaned: [] });
    expect(validateExtraData([])).toEqual({ errors: [], cleaned: [] });
  });

  test("non-array input is rejected", () => {
    const { errors } = validateExtraData({ name: "x", sql: "select 1" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/array/i);
  });

  test("valid two-entry array passes", () => {
    const result = validateExtraData([
      { name: "volcanos", sql: "SELECT * FROM volcanos" },
      { name: "earthquakes", sql: "SELECT * FROM earthquakes" },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.cleaned).toHaveLength(2);
    expect(result.cleaned[0]).toEqual({ name: "volcanos", sql: "SELECT * FROM volcanos" });
  });

  test("trims whitespace from name and sql", () => {
    const { cleaned, errors } = validateExtraData([{ name: "  vols  ", sql: "  SELECT 1  " }]);
    expect(errors).toEqual([]);
    expect(cleaned[0]).toEqual({ name: "vols", sql: "SELECT 1" });
  });

  test("name reserved as __cupola_data is rejected", () => {
    const { errors } = validateExtraData([{ name: "__cupola_data", sql: "SELECT 1" }]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/reserved/i);
  });

  test("name with invalid pattern is rejected", () => {
    expect(validateExtraData([{ name: "1foo", sql: "SELECT 1" }]).errors.length).toBeGreaterThan(0);
    expect(validateExtraData([{ name: "has space", sql: "SELECT 1" }]).errors.length).toBeGreaterThan(0);
    expect(validateExtraData([{ name: "has-dash", sql: "SELECT 1" }]).errors.length).toBeGreaterThan(0);
    expect(validateExtraData([{ name: "dot.notation", sql: "SELECT 1" }]).errors.length).toBeGreaterThan(0);
  });

  test("valid name patterns pass", () => {
    const ok = (n: string) => {
      const r = validateExtraData([{ name: n, sql: "SELECT 1" }]);
      expect(r.errors).toEqual([]);
    };
    ok("foo");
    ok("Foo");
    ok("_foo");
    ok("foo_bar");
    ok("foo123");
    ok("FOO_BAR_42");
  });

  test("duplicate names rejected", () => {
    const { errors } = validateExtraData([
      { name: "x", sql: "SELECT 1" },
      { name: "x", sql: "SELECT 2" },
    ]);
    expect(errors.some((e) => e.includes("duplicated"))).toBe(true);
  });

  test("empty SQL rejected", () => {
    expect(validateExtraData([{ name: "x", sql: "" }]).errors.length).toBeGreaterThan(0);
    expect(validateExtraData([{ name: "x", sql: "   " }]).errors.length).toBeGreaterThan(0);
  });

  test("missing name rejected", () => {
    const { errors } = validateExtraData([{ sql: "SELECT 1" }]);
    expect(errors[0]).toMatch(/name is required/i);
  });

  test("count > 5 is rejected", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ name: `a${i}`, sql: `SELECT ${i}` }));
    const { errors } = validateExtraData(items);
    expect(errors.some((e) => e.includes("max 5"))).toBe(true);
  });

  test("count = 5 passes (boundary)", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, sql: `SELECT ${i}` }));
    const { errors, cleaned } = validateExtraData(items);
    expect(errors).toEqual([]);
    expect(cleaned).toHaveLength(5);
  });

  test("non-object item rejected", () => {
    const { errors } = validateExtraData(["not an object"]);
    expect(errors[0]).toMatch(/must be an object/i);
  });
});
