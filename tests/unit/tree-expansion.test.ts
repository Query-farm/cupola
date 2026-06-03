import { test, expect, describe } from "bun:test";
import {
  collectAncestorIds,
  revealPath,
  toggleExpanded,
  collectExpandableIds,
} from "../../src/lib/tree-expansion";
import type { TreeDataItem } from "../../src/lib/tree";

// catalog
//  ├─ schemaA
//  │   ├─ tableA1  (leaf)
//  │   └─ tableA2
//  │       └─ colA2  (leaf)
//  └─ schemaB
//      └─ tableB1  (leaf)
const tree: TreeDataItem[] = [
  {
    id: "catalog",
    name: "catalog",
    children: [
      {
        id: "schemaA",
        name: "schemaA",
        children: [
          { id: "tableA1", name: "tableA1" },
          {
            id: "tableA2",
            name: "tableA2",
            children: [{ id: "colA2", name: "colA2" }],
          },
        ],
      },
      {
        id: "schemaB",
        name: "schemaB",
        children: [{ id: "tableB1", name: "tableB1" }],
      },
    ],
  },
];

describe("collectAncestorIds", () => {
  test("returns ancestors of a deep node, root-first, excluding the target", () => {
    expect(collectAncestorIds(tree, "colA2")).toEqual([
      "catalog",
      "schemaA",
      "tableA2",
    ]);
  });

  test("excludes the target node itself", () => {
    expect(collectAncestorIds(tree, "tableA2")).toEqual(["catalog", "schemaA"]);
    expect(collectAncestorIds(tree, "tableA2")).not.toContain("tableA2");
  });

  test("returns [] for a root node", () => {
    expect(collectAncestorIds(tree, "catalog")).toEqual([]);
  });

  test("returns [] for an unknown id", () => {
    expect(collectAncestorIds(tree, "nope")).toEqual([]);
  });
});

describe("revealPath", () => {
  test("adds the ancestors of a deep node", () => {
    const result = revealPath(new Set(), tree, "colA2");
    expect([...result].sort()).toEqual(["catalog", "schemaA", "tableA2"]);
  });

  test("does NOT add the target node itself (regression: collapse must stick)", () => {
    // This is the crux of the bug fix: selecting a node never forces its own
    // expansion, so a chevron click that both selects and collapses still collapses.
    expect(revealPath(new Set(), tree, "tableA2").has("tableA2")).toBe(false);
    expect(revealPath(new Set(), tree, "schemaA").has("schemaA")).toBe(false);
  });

  test("never removes a pre-existing entry", () => {
    const prev = new Set(["schemaB"]);
    const result = revealPath(prev, tree, "colA2");
    expect(result.has("schemaB")).toBe(true);
  });

  test("is idempotent", () => {
    const once = revealPath(new Set(), tree, "colA2");
    const twice = revealPath(once, tree, "colA2");
    expect([...twice].sort()).toEqual([...once].sort());
  });

  test("returns the same set (no-op) for an undefined target", () => {
    const prev = new Set(["schemaA"]);
    expect(revealPath(prev, tree, undefined)).toBe(prev);
  });

  test("returns the same set (no-op) for a root target", () => {
    const prev = new Set(["schemaA"]);
    expect(revealPath(prev, tree, "catalog")).toBe(prev);
  });
});

describe("toggleExpanded", () => {
  test("adds an absent id", () => {
    expect([...toggleExpanded(new Set(), "schemaA")]).toEqual(["schemaA"]);
  });

  test("removes a present id", () => {
    expect([...toggleExpanded(new Set(["schemaA"]), "schemaA")]).toEqual([]);
  });

  test("returns a new Set without mutating the input", () => {
    const prev = new Set(["schemaA"]);
    const next = toggleExpanded(prev, "schemaB");
    expect(next).not.toBe(prev);
    expect([...prev]).toEqual(["schemaA"]);
  });

  test("round-trips: toggling twice restores the original", () => {
    const prev = new Set(["schemaA"]);
    const there = toggleExpanded(prev, "schemaB");
    const back = toggleExpanded(there, "schemaB");
    expect([...back].sort()).toEqual([...prev].sort());
  });
});

describe("collectExpandableIds", () => {
  test("returns exactly the node-with-children ids (no leaves)", () => {
    expect(collectExpandableIds(tree).sort()).toEqual([
      "catalog",
      "schemaA",
      "schemaB",
      "tableA2",
    ]);
  });

  test("returns [] for a flat list of leaves", () => {
    expect(
      collectExpandableIds([
        { id: "a", name: "a" },
        { id: "b", name: "b" },
      ])
    ).toEqual([]);
  });
});
