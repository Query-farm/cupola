import { describe, expect, test } from "bun:test";
import { hashToSelection, selectionToHash } from "../../src/lib/navigation";

describe("relationship explorer navigation", () => {
  test("round trips catalog relationships", () => {
    const selection = { type: "relationships" as const, name: "relationships" };
    expect(selectionToHash(selection)).toBe("#/relationships");
    expect(hashToSelection("#/relationships")).toEqual(selection);
  });

  test("round trips a focused schema table", () => {
    const selection = {
      type: "relationships" as const,
      name: "relationships",
      schema: "sales data",
      focusTable: "line/items",
    };
    const hash = selectionToHash(selection);
    expect(hash).toBe("#/schema/sales%20data/relationships/table/line%2Fitems");
    expect(hashToSelection(hash)).toEqual(selection);
  });
});

