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
    expect(getTag({ "vgi.columns_md": "old" }, TAG_RESULT_COLUMNS_MD)).toBe("old");
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
      [TAG_KEYWORDS]: "[]",
      [TAG_CATEGORY]: "eruptions",
      [TAG_TITLE]: "Nice",
      domain: "volcanology",
    });
  });
  it("never emits agent_test_tasks and returns undefined when empty", () => {
    expect(filterTagsForAI({ [TAG_AGENT_TEST_TASKS]: "[]" })).toBeUndefined();
    expect(filterTagsForAI(null)).toBeUndefined();
  });
});
