import { describe, expect, test } from "bun:test";
import {
  executeDescribeTable,
  executeListCatalogs,
  executeListCategories,
  executeListTables,
} from "../../src/lib/ai-agent";
import type { CatalogData } from "../../src/lib/service";

function catalog(name: string, table: string, category = "reference"): CatalogData {
  return {
    catalogName: name,
    catalogComment: `${name} worker`,
    catalogTags: { "vgi.doc_llm": `${name} documentation`, "vgi.agent_test_tasks": "private" },
    defaultSchema: "main",
    schemas: [{
      info: {
        name: "main",
        comment: "Main schema",
        tags: { "vgi.categories": JSON.stringify([{ name: category, description: "Reference data" }]) },
        attach_opaque_data: new Uint8Array(),
      },
      tables: [{
        name: table,
        schema_name: "main",
        comment: `${table} rows`,
        tags: { "vgi.category": category, "vgi_required_filters": '[["id"]]' },
        columns: new Uint8Array(),
        not_null_constraints: [], unique_constraints: [], check_constraints: [],
        primary_key_constraints: [], foreign_key_constraints: [],
        supports_insert: false, supports_update: false, supports_delete: false,
        supports_returning: false, supports_column_statistics: false, required_filters: [["id"]],
      }],
      views: [], functions: [], macros: [],
    }],
  } as CatalogData;
}

describe("multi-catalog agent discovery", () => {
  test("lists attached catalogs without exposing agent graders", () => {
    const result = JSON.parse(executeListCatalogs([catalog("alpha", "items"), catalog("beta", "places")]));
    expect(result.catalogs.map((item: any) => item.catalog)).toEqual(["alpha", "beta"]);
    expect(JSON.stringify(result)).not.toContain("agent_test_tasks");
  });

  test("requires an explicit catalog when multiple workers are attached", () => {
    const result = JSON.parse(executeListTables([catalog("alpha", "items"), catalog("beta", "places")]));
    expect(result.error).toContain("Catalog is required");
    expect(result.catalogs).toEqual(["alpha", "beta"]);
  });

  test("filters by category and returns fully-qualified identities", () => {
    const result = JSON.parse(executeListTables(
      [catalog("alpha", "items"), catalog("beta", "places")],
      { catalog: "beta", category: "reference" },
    ));
    expect(result.objects[0].qualified_name).toBe("beta.main.places");
    expect(result.objects[0].catalog).toBe("beta");
  });

  test("describes the selected worker and exposes required filters", () => {
    const result = JSON.parse(executeDescribeTable(
      [catalog("alpha", "items"), catalog("beta", "places")],
      "main", "places", "beta",
    ));
    expect(result.qualified_name).toBe("beta.main.places");
    expect(result.required_filters).toEqual([["id"]]);
    expect(result.tags.vgi_required_filters).toBe('[["id"]]');
  });

  test("lists schema category registries per catalog", () => {
    const result = JSON.parse(executeListCategories([catalog("alpha", "items")], { catalog: "alpha" }));
    expect(result.schemas[0].categories[0].name).toBe("reference");
  });
});
