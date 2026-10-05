import { describe, expect, test } from "bun:test";
import { hashToSelection, pageTitle, resolveSelection, selectionToHash } from "../../src/lib/navigation";
import type { Selection } from "../../src/lib/tree";

describe("catalog-qualified hash routes", () => {
  const cases: [Selection, string][] = [
    [{ type: "catalog", name: "sales", catalog: "sales" }, "#/catalog/sales"],
    [{ type: "schema", name: "main", schema: "main", catalog: "sales" }, "#/catalog/sales/schema/main"],
    [{ type: "table", name: "orders", schema: "main", catalog: "sales_2" }, "#/catalog/sales_2/schema/main/table/orders"],
    [{ type: "view", name: "v", schema: "s", catalog: "c" }, "#/catalog/c/schema/s/view/v"],
    [{ type: "function", name: "f", schema: "s", catalog: "c" }, "#/catalog/c/schema/s/function/f"],
    [{ type: "macro", name: "m", schema: "s", catalog: "c" }, "#/catalog/c/schema/s/macro/m"],
    [{ type: "relationships", name: "relationships", catalog: "c" }, "#/catalog/c/relationships"],
    [{ type: "relationships", name: "relationships", schema: "s", catalog: "c" }, "#/catalog/c/schema/s/relationships"],
    [{ type: "relationships", name: "relationships", schema: "s", focusTable: "t", catalog: "c" }, "#/catalog/c/schema/s/relationships/table/t"],
  ];
  for (const [selection, hash] of cases) {
    test(`${selection.type} round trips through ${hash}`, () => {
      expect(selectionToHash(selection)).toBe(hash);
      expect(hashToSelection(hash)).toEqual(selection);
    });
  }

  test("names with slashes, spaces and unicode are encoded per segment", () => {
    const selection: Selection = { type: "table", name: "a/b c", schema: "sché ma", catalog: "my cat" };
    const hash = selectionToHash(selection);
    expect(hash).toBe("#/catalog/my%20cat/schema/sch%C3%A9%20ma/table/a%2Fb%20c");
    expect(hashToSelection(hash)).toEqual(selection);
  });
});

describe("legacy hash routes", () => {
  test("decode without a catalog, and resolve to the default catalog", () => {
    const legacy = hashToSelection("#/schema/small/table/regions");
    expect(legacy).toEqual({ type: "table", name: "regions", schema: "small" });
    expect(resolveSelection(legacy, "cupola_test")).toEqual({ type: "table", name: "regions", schema: "small", catalog: "cupola_test" });
    expect(hashToSelection("#/schema/small")).toEqual({ type: "schema", name: "small", schema: "small" });
  });

  test("a selection that already names a catalog is left alone", () => {
    const sel: Selection = { type: "schema", name: "s", schema: "s", catalog: "other" };
    expect(resolveSelection(sel, "default")).toBe(sel);
    expect(resolveSelection(null, "default")).toBeNull();
  });

  test("selections without a catalog still encode in the legacy form", () => {
    expect(selectionToHash({ type: "schema", name: "s", schema: "s" })).toBe("#/schema/s");
    expect(selectionToHash({ type: "catalog", name: "x" })).toBe("");
  });
});

describe("malformed hashes", () => {
  for (const hash of ["", "#", "#/", "#/catalog", "#/catalog/", "#/catalog/c/nope", "#/schema", "#/catalog/c/schema/s/widget/x", "#/schema/s/table", "#token=abc", "#/catalog/%E0%A4%A"]) {
    test(JSON.stringify(hash), () => {
      expect(hashToSelection(hash)).toBeNull();
    });
  }
});

describe("page titles", () => {
  test("use the selection's own catalog, falling back to the default", () => {
    expect(pageTitle({ type: "table", name: "t", schema: "s", catalog: "other" }, "main_cat")).toBe("other / s / t - VGI");
    expect(pageTitle({ type: "table", name: "t", schema: "s" }, "main_cat")).toBe("main_cat / s / t - VGI");
    expect(pageTitle({ type: "catalog", name: "other", catalog: "other" }, "main_cat")).toBe("other - VGI");
    expect(pageTitle(null, "main_cat")).toBe("main_cat - VGI");
    expect(pageTitle({ type: "schema", name: "s", schema: "s", catalog: "c" }, "d")).toBe("c / s - VGI");
  });
});
