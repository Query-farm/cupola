import { describe, it, expect } from "bun:test";
import {
  getTag,
  parseKeywords,
  parseClassificationTags,
  parseDocLinks,
  parseCategories,
  parseExecutableExamples,
  categoryTitle,
  groupByCategory,
  filterDisplayTags,
  filterTagsForAI,
  filterTagsForAIDetail,
  formatAITagValue,
  examplesForAI,
  parseRequiredFilters,
  TAG_CATEGORIES,
  TAG_EXECUTABLE_EXAMPLES,
  TAG_REQUIRED_FILTERS,
  TAG_DOC_LLM,
  TAG_DOC_MD,
  TAG_RESULT_COLUMNS_MD,
  TAG_CLASSIFICATION_TAGS,
  TAG_KEYWORDS,
  TAG_CATEGORY,
  TAG_AGENT_TEST_TASKS,
  TAG_EXAMPLE_QUERIES,
  TAG_TITLE,
  type CategoryDef,
} from "../../src/lib/tags";

describe("getTag", () => {
  it("reads the canonical key", () => {
    expect(getTag({ [TAG_DOC_LLM]: "hi" }, TAG_DOC_LLM)).toBe("hi");
  });
  it("falls back to the deprecated alias when canonical is absent", () => {
    expect(getTag({ "vgi.description_llm": "old" }, TAG_DOC_LLM)).toBe("old");
    expect(getTag({ "vgi.description_md": "old" }, TAG_DOC_MD)).toBe("old");
    // Retired result-schema keys are deliberately not aliases: their shape changed.
    expect(getTag({ "vgi.columns_md": "old" }, TAG_RESULT_COLUMNS_MD)).toBeUndefined();
    expect(getTag({ "vgi.category_tags": '["x"]' }, TAG_CLASSIFICATION_TAGS)).toBe('["x"]');
  });
  it("prefers the canonical key over the deprecated alias", () => {
    expect(getTag({ [TAG_DOC_LLM]: "new", "vgi.description_llm": "old" }, TAG_DOC_LLM)).toBe("new");
  });
  it("treats a blank canonical value as absent and falls back", () => {
    expect(getTag({ [TAG_DOC_LLM]: "   ", "vgi.description_llm": "old" }, TAG_DOC_LLM)).toBe("old");
  });
  it("returns undefined for missing or blank with no alias", () => {
    expect(getTag({}, TAG_KEYWORDS)).toBeUndefined();
    expect(getTag({ [TAG_KEYWORDS]: "  " }, TAG_KEYWORDS)).toBeUndefined();
    expect(getTag(null, TAG_KEYWORDS)).toBeUndefined();
  });
});

describe("bounded AI metadata", () => {
  it("keeps rich detail bounded and never emits private task graders", () => {
    const detail = filterTagsForAIDetail({
      [TAG_DOC_MD]: "x".repeat(5_000),
      [TAG_AGENT_TEST_TASKS]: '[{"name":"secret"}]',
    })!;
    expect(detail[TAG_DOC_MD].length).toBeLessThan(4_050);
    expect(detail[TAG_AGENT_TEST_TASKS]).toBeUndefined();
  });
});

describe("examplesForAI", () => {
  it("merges native + tag examples, dedupes on normalized SQL, caps at five", () => {
    const tags = {
      [TAG_EXAMPLE_QUERIES]: JSON.stringify([
        { description: "dup", sql: "select   1" },
        { description: "two", sql: "SELECT 2" },
        { sql: "" },
        "not an object",
      ]),
      [TAG_EXECUTABLE_EXAMPLES]: JSON.stringify([
        { description: "three", sql: ["SELECT 3", "SELECT 4"] },
        { description: "five", sql: "SELECT 5" },
        { description: "six", sql: "SELECT 6" },
        { description: "seven", sql: "SELECT 7" },
      ]),
    };
    const out = examplesForAI(tags, [{ sql: "SELECT 1", description: "native" }]);
    expect(out.map((e) => e.sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3;\n\nSELECT 4", "SELECT 5", "SELECT 6"]);
    expect(out[0].description).toBe("native");
    expect(out).toHaveLength(5);
  });
  it("bounds each example body", () => {
    const out = examplesForAI({ [TAG_EXAMPLE_QUERIES]: JSON.stringify([{ sql: "x".repeat(5_000) }]) });
    expect(out[0].sql.length).toBeLessThan(4_050);
    expect(out[0].description).toBeNull();
  });
});

describe("parseRequiredFilters", () => {
  it("decodes an AND of OR-groups and drops malformed entries", () => {
    expect(parseRequiredFilters({ [TAG_REQUIRED_FILTERS]: '[["a"],["b","c"]]' })).toEqual([["a"], ["b", "c"]]);
    expect(parseRequiredFilters({ [TAG_REQUIRED_FILTERS]: '[["a"], "b", [], [1, "c"]]' })).toEqual([["a"], ["c"]]);
    expect(parseRequiredFilters({ [TAG_REQUIRED_FILTERS]: "nope" })).toEqual([]);
    expect(parseRequiredFilters(null)).toEqual([]);
  });
});

describe("JSON array parsers", () => {
  it("parseKeywords / parseClassificationTags return trimmed non-empty strings", () => {
    expect(parseKeywords({ [TAG_KEYWORDS]: '["a"," b ","",3]' })).toEqual(["a", "b"]);
    expect(parseClassificationTags({ [TAG_CLASSIFICATION_TAGS]: '["geo","ts"]' })).toEqual(["geo", "ts"]);
  });
  it("resolves classification tags via the deprecated alias", () => {
    expect(parseClassificationTags({ "vgi.category_tags": '["x","y"]' })).toEqual(["x", "y"]);
  });
  it("returns [] on malformed / non-array / absent JSON", () => {
    expect(parseKeywords({ [TAG_KEYWORDS]: "not json" })).toEqual([]);
    expect(parseKeywords({ [TAG_KEYWORDS]: '"a,b"' })).toEqual([]); // comma-string not accepted
    expect(parseKeywords({})).toEqual([]);
  });
});

describe("parseDocLinks", () => {
  it("accepts URL strings and {title,url} objects", () => {
    const links = parseDocLinks({
      "vgi.doc_links": '["https://a.example",{"title":"RFC","url":"https://b.example"},{"url":"https://c.example"}]',
    });
    expect(links).toEqual([
      { url: "https://a.example" },
      { url: "https://b.example", title: "RFC" },
      { url: "https://c.example" },
    ]);
  });
  it("drops entries with no url and returns [] on malformed", () => {
    expect(parseDocLinks({ "vgi.doc_links": '[{"title":"x"}]' })).toEqual([]);
    expect(parseDocLinks({ "vgi.doc_links": "oops" })).toEqual([]);
  });
});

describe("parseCategories", () => {
  it("parses an ordered registry, skipping nameless entries", () => {
    const reg = parseCategories({
      "vgi.categories": '[{"name":"geocoding","title":"Geocoding","description":"Addresses."},{"title":"no name"},{"name":"routing"}]',
    });
    expect(reg.map((c) => c.name)).toEqual(["geocoding", "routing"]);
    expect(reg[0]).toEqual({ name: "geocoding", title: "Geocoding", description: "Addresses.", keywords: undefined, doc_md: undefined });
  });
  it("returns [] on malformed", () => {
    expect(parseCategories({ "vgi.categories": "{" })).toEqual([]);
  });
});

describe("categoryTitle", () => {
  it("uses title, else title-cases the slug", () => {
    expect(categoryTitle({ name: "trading_calendars" } as CategoryDef)).toBe("Trading Calendars");
    expect(categoryTitle({ name: "x", title: "Custom" } as CategoryDef)).toBe("Custom");
  });
});

describe("parseExecutableExamples", () => {
  it("flattens string, list-of-strings, and step-object sql", () => {
    const ex = parseExecutableExamples({
      "vgi.executable_examples": JSON.stringify([
        { description: "one", sql: "SELECT 1" },
        { name: "multi", sql: ["SELECT 1", "SELECT 2"] },
        { description: "steps", sql: [{ sql: "SELECT 1", expected_result: [[1]] }, { sql: "SELECT 2" }] },
        { description: "empty", sql: "" },
      ]),
    });
    expect(ex).toEqual([
      { name: undefined, description: "one", sql: "SELECT 1" },
      { name: "multi", description: undefined, sql: "SELECT 1;\n\nSELECT 2" },
      { name: undefined, description: "steps", sql: "SELECT 1;\n\nSELECT 2" },
    ]);
  });
  it("returns [] on malformed", () => {
    expect(parseExecutableExamples({ "vgi.executable_examples": "nope" })).toEqual([]);
  });
});

describe("groupByCategory", () => {
  const registry = parseCategories({
    "vgi.categories": '[{"name":"catalog"},{"name":"eruptions"},{"name":"emissions"}]',
  });
  type Obj = { name: string; cat?: string };
  const get = (o: Obj) => o.cat;

  it("groups in registry order with a trailing Uncategorized bucket, dropping empty categories", () => {
    const items: Obj[] = [
      { name: "holocene", cat: "catalog" },
      { name: "recent", cat: "eruptions" },
      { name: "loose", cat: undefined },
      { name: "unknown", cat: "nope" },
    ];
    const groups = groupByCategory(items, get, registry);
    expect(groups).not.toBeNull();
    expect(groups!.map((g) => (g.def ? g.def.name : "UNCATEGORIZED"))).toEqual([
      "catalog",
      "eruptions",
      "UNCATEGORIZED",
    ]);
    expect(groups!.find((g) => g.def === null)!.items.map((i) => i.name)).toEqual(["loose", "unknown"]);
  });

  it("returns null when there is no registry", () => {
    expect(groupByCategory([{ name: "a", cat: "x" }], get, [])).toBeNull();
  });

  it("returns null when no object references a registry category (legacy fallback)", () => {
    expect(groupByCategory([{ name: "a" }, { name: "b", cat: "zzz" }], get, registry)).toBeNull();
  });
});

describe("filterDisplayTags", () => {
  it("strips every reserved tag (canonical + deprecated), keeping free-form", () => {
    const out = filterDisplayTags({
      [TAG_DOC_LLM]: "x",
      "vgi.description_md": "y",
      [TAG_CATEGORY]: "eruptions",
      [TAG_KEYWORDS]: "[]",
      [TAG_AGENT_TEST_TASKS]: "[]",
      domain: "volcanology",
      provider: "Smithsonian",
    });
    expect(out).toEqual({ domain: "volcanology", provider: "Smithsonian" });
  });
  it("returns null when only reserved tags remain", () => {
    expect(filterDisplayTags({ [TAG_DOC_LLM]: "x" })).toBeNull();
    expect(filterDisplayTags(null)).toBeNull();
  });
});

describe("filterTagsForAI", () => {
  it("keeps discovery signals + free-form, drops docs_md/examples/provenance", () => {
    const out = filterTagsForAI({
      [TAG_DOC_LLM]: "llm",
      [TAG_DOC_MD]: "md",
      [TAG_KEYWORDS]: "[]",
      [TAG_CATEGORY]: "eruptions",
      [TAG_TITLE]: "Nice",
      [TAG_EXAMPLE_QUERIES]: "[]",
      "vgi.source_url": "https://x",
      domain: "volcanology",
    });
    expect(out).toEqual({
      [TAG_DOC_LLM]: "llm",
      [TAG_KEYWORDS]: [],
      [TAG_CATEGORY]: "eruptions",
      [TAG_TITLE]: "Nice",
      domain: "volcanology",
    });
  });
  it("decodes JSON-valued keys instead of shipping escaped strings", () => {
    const out = filterTagsForAI({
      [TAG_KEYWORDS]: '["volcano","eruption"]',
      [TAG_CLASSIFICATION_TAGS]: '["geospatial"]',
      "vgi.category_tags": '["legacy"]',
      [TAG_REQUIRED_FILTERS]: '[["id"]]',
      [TAG_CATEGORIES]: '[{"name":"eruptions"}]',
      broken: "{not json",
    })!;
    expect(out[TAG_KEYWORDS]).toEqual(["volcano", "eruption"]);
    expect(out[TAG_CLASSIFICATION_TAGS]).toEqual(["geospatial"]);
    expect(out["vgi.category_tags"]).toEqual(["legacy"]);
    expect(out[TAG_REQUIRED_FILTERS]).toEqual([["id"]]);
    // The registry is served by list_categories; listings never repeat it.
    expect(out[TAG_CATEGORIES]).toBeUndefined();
    expect(out.broken).toBe("{not json");
    expect(formatAITagValue(out[TAG_KEYWORDS])).toBe("volcano, eruption");
    expect(formatAITagValue("plain")).toBe("plain");
    expect(formatAITagValue([{ a: 1 }])).toBe('[{"a":1}]');
  });
  it("detail drops the keys that describe tools lift into dedicated fields", () => {
    const out = filterTagsForAIDetail({
      [TAG_EXAMPLE_QUERIES]: '[{"description":"d","sql":"SELECT 1"}]',
      [TAG_EXECUTABLE_EXAMPLES]: '[{"description":"d","sql":"SELECT 2"}]',
      [TAG_REQUIRED_FILTERS]: '[["id"]]',
      [TAG_DOC_MD]: "md",
    })!;
    expect(Object.keys(out)).toEqual([TAG_DOC_MD]);
  });
  it("never emits agent_test_tasks and returns undefined when empty", () => {
    expect(filterTagsForAI({ [TAG_AGENT_TEST_TASKS]: "[]" })).toBeUndefined();
    expect(filterTagsForAI(null)).toBeUndefined();
  });
});
