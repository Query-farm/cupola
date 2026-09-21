import { describe, expect, test } from "bun:test";

import { memoryContextNote, memoryObjectNames } from "../../src/lib/ai/memory-context";
import type { CatalogData } from "../../src/lib/service";

function memoryCatalog(tables: string[], views: string[] = []): CatalogData {
  return {
    catalogName: "memory",
    catalogComment: null,
    catalogTags: {},
    defaultSchema: "main",
    schemas: [{
      info: { name: "main", comment: null, tags: {} },
      tables: tables.map((name) => ({ name })),
      views: views.map((name) => ({ name })),
      macros: [],
      functions: [],
    }],
  } as unknown as CatalogData;
}

describe("memoryObjectNames", () => {
  test("returns empty for a missing catalog rather than throwing", () => {
    expect(memoryObjectNames(null)).toEqual([]);
    expect(memoryObjectNames(undefined)).toEqual([]);
  });

  test("qualifies tables and views and sorts them", () => {
    expect(memoryObjectNames(memoryCatalog(["zeta", "alpha"], ["mid"]))).toEqual([
      "memory.main.alpha",
      "memory.main.mid",
      "memory.main.zeta",
    ]);
  });

  test("is stable against introspection order", () => {
    expect(memoryObjectNames(memoryCatalog(["b", "a"])))
      .toEqual(memoryObjectNames(memoryCatalog(["a", "b"])));
  });
});

describe("memoryContextNote", () => {
  test("says nothing when nothing changed — the common turn costs no tokens", () => {
    expect(memoryContextNote([], [])).toBeNull();
    expect(memoryContextNote(["memory.main.a"], ["memory.main.a"])).toBeNull();
  });

  test("names tables the agent created since the prompt was frozen", () => {
    const note = memoryContextNote(["memory.main.a"], ["memory.main.a", "memory.main.b"]);
    expect(note).toContain("Now present: memory.main.b");
    expect(note).not.toContain("No longer present");
    expect(note).toContain("describe_table");
  });

  test("reports drops as well as additions", () => {
    const note = memoryContextNote(["memory.main.a", "memory.main.b"], ["memory.main.b"]);
    expect(note).toContain("No longer present: memory.main.a");
    expect(note).not.toContain("Now present");
  });
});
