import { expect, test } from "bun:test";
import { selectionAfterDdl } from "../../src/lib/ddl-navigation";
import type { CatalogData } from "../../src/lib/service";

type Spec = Record<string, Record<string, { tables?: string[]; views?: string[]; cols?: number }>>;
function inventory(spec: Spec): CatalogData[] {
  return Object.entries(spec).map(([catalogName, schemaSpec]) => ({
    catalogName, catalogComment: null, catalogTags: {}, defaultSchema: "main",
    schemas: Object.entries(schemaSpec).map(([name, s]) => ({
      info: { name },
      tables: (s.tables ?? []).map(t => ({ name: t, columns: Array.from({ length: s.cols ?? 1 }, (_, i) => `c${i}`) })),
      views: (s.views ?? []).map(v => ({ name: v })),
      functions: [],
    })) as any,
  }));
}

test("a table created in another catalog opens there, not in memory", () => {
  const before = inventory({ memory: { main: {} }, mydb: { main: {} } });
  const after = inventory({ memory: { main: {} }, mydb: { main: { tables: ["Sales 2024"] } } });
  expect(selectionAfterDdl(before, after)).toEqual({ type: "table", name: "Sales 2024", schema: "main", catalog: "mydb" });
});

test("a view opens as a view", () => {
  const before = inventory({ memory: { main: {} } });
  const after = inventory({ memory: { main: { views: ["v"] } } });
  expect(selectionAfterDdl(before, after)?.type).toBe("view");
});

test("CREATE OR REPLACE opens the replaced table", () => {
  const before = inventory({ memory: { main: { tables: ["a", "t"] } } });
  const after = inventory({ memory: { main: { tables: ["a", "t"], cols: 1 } } });
  after[0].schemas[0].tables[1] = { ...after[0].schemas[0].tables[1], columns: ["c0", "c1"] } as any;
  expect(selectionAfterDdl(before, after)).toMatchObject({ type: "table", name: "t" });
});

test("a drop goes to the parent schema, or the catalog when the schema went too", () => {
  const before = inventory({ memory: { main: { tables: ["t"] }, s: { tables: ["u"] } } });
  expect(selectionAfterDdl(before, inventory({ memory: { main: {}, s: { tables: ["u"] } } }))).toEqual({ type: "schema", name: "main", schema: "main", catalog: "memory" });
  expect(selectionAfterDdl(before, inventory({ memory: { main: { tables: ["t"] } } }))).toEqual({ type: "catalog", name: "memory", catalog: "memory" });
});

test("TEMP objects and no-ops change nothing", () => {
  const same = inventory({ memory: { main: { tables: ["t"] } } });
  expect(selectionAfterDdl(same, inventory({ memory: { main: { tables: ["t"] } } }))).toBeNull();
});
