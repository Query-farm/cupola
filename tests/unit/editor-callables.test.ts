/**
 * The shared pieces behind sidebar insert, the hover card, the Inspector and
 * in-editor signature help: the callable model, name resolution, snippet text
 * and the cursor's call context.
 */
import { test, expect, describe } from "bun:test";
import type { FunctionInfo, MacroInfo } from "../../src/lib/vgi-catalog-types";
import type { CatalogData } from "../../src/lib/service";
import type { FunctionArg } from "../../src/lib/function-info";
import { functionCallable, macroCallable, macroArgs, findCallables } from "../../src/lib/callable";
import { buildCatalogIndex, resolveCallable } from "../../src/lib/catalog-index";
import { buildCallSnippet, buildCallText, qualifiedName, requiredArgs, sqlIdentifier } from "../../src/lib/editor/call-snippet";
import { findCallAtPos, callNameAt } from "../../src/lib/editor/call-context";

function arg(name: string, extra: Partial<FunctionArg> = {}): FunctionArg {
  return {
    name, arrowType: "BIGINT", duckdbType: "BIGINT", nullable: true, named: false, positional: true,
    isTableInput: false, isAnyType: false, isVarargs: false, isConst: false, ...extra,
  };
}

function func(name: string, args: FunctionArg[], type: FunctionInfo["function_type"] = "TABLE", schema = "edge"): FunctionInfo {
  return {
    name, schema_name: schema, function_type: type, arguments: new Uint8Array(), output_schema: new Uint8Array(),
    description: `${name} docs`, tags: {}, examples: [],
    _functionArgs: args,
    _functionReturn: { isTable: type === "TABLE", columns: type === "TABLE" ? [] : [{ name: "return", arrowType: "DOUBLE", duckdbType: "DOUBLE", nullable: true }] },
  } as unknown as FunctionInfo;
}

function macro(name: string, parameters: string[], extra: Record<string, unknown> = {}): MacroInfo {
  return { name, schema_name: "main", macro_type: "SCALAR", parameters, definition: "a + b", tags: {}, ...extra } as unknown as MacroInfo;
}

function catalog(name: string, schemas: Record<string, { functions?: FunctionInfo[]; macros?: MacroInfo[] }>, primary = false): CatalogData {
  return {
    catalogName: name, primary, catalogComment: null, catalogTags: {}, defaultSchema: null,
    schemas: Object.entries(schemas).map(([s, v]) => ({
      info: { name: s, comment: null, tags: {} } as never, tables: [], views: [], functions: v.functions ?? [], macros: v.macros ?? [],
    })),
  };
}

const slowRows = func("slow_rows", [arg("rows"), arg("delay_ms")]);

describe("callable", () => {
  test("function signature and description", () => {
    const c = functionCallable("cupola_test", slowRows);
    expect(c.signature).toBe("slow_rows(rows BIGINT, delay_ms BIGINT) → TABLE");
    expect(c.description).toBe("slow_rows docs");
    expect(c.isTable).toBe(true);
  });

  test("a plain DuckDB macro falls back to its parameter names", () => {
    const m = macro("pw_add", ["a", "b"], { _functionArgs: [], _parameterTypes: [null, "INTEGER"] });
    expect(macroArgs(m).map((a) => `${a.name}:${a.duckdbType}`)).toEqual(["a:ANY", "b:INTEGER"]);
    expect(macroCallable("memory", m).signature).toBe("pw_add(a ANY, b INTEGER)");
  });

  test("overloads are all returned", () => {
    const cats = [catalog("c", { s: { functions: [func("f", [arg("x")], "SCALAR", "s"), func("f", [arg("x"), arg("y")], "SCALAR", "s")] } })];
    expect(findCallables(cats, "c", "s", "f", "function")).toHaveLength(2);
  });
});

describe("catalog index", () => {
  const cats = [
    catalog("memory", { main: { macros: [macro("slow_rows", ["a"])] } }),
    catalog("cupola_test", { edge: { functions: [slowRows] } }, true),
  ];
  const index = buildCatalogIndex(cats);

  test("is cached per catalogs array", () => {
    expect(buildCatalogIndex(cats)).toBe(index);
  });

  test("bare names list the primary catalog first", () => {
    expect(resolveCallable(index, ["SLOW_ROWS"]).map((c) => c.catalog)).toEqual(["cupola_test", "memory"]);
  });

  test("two parts match a schema or a catalog", () => {
    expect(resolveCallable(index, ["edge", "slow_rows"]).map((c) => c.catalog)).toEqual(["cupola_test"]);
    expect(resolveCallable(index, ["memory", "slow_rows"]).map((c) => c.catalog)).toEqual(["memory"]);
  });

  test("three parts are exact", () => {
    expect(resolveCallable(index, ["cupola_test", "edge", "slow_rows"])).toHaveLength(1);
    expect(resolveCallable(index, ["cupola_test", "main", "slow_rows"])).toHaveLength(0);
  });
});

describe("call snippets", () => {
  const c = functionCallable("cupola_test", slowRows);

  test("table function into an empty editor is a whole statement", () => {
    expect(buildCallText(c, { emptyDoc: true })).toBe("SELECT * FROM cupola_test.edge.slow_rows(rows, delay_ms)");
    expect(buildCallSnippet(c, { emptyDoc: true })).toBe("SELECT * FROM cupola_test.edge.slow_rows(${1:rows}, ${2:delay_ms})${0}");
  });

  test("anywhere else it is the bare call", () => {
    expect(buildCallText(c, { emptyDoc: false })).toBe("cupola_test.edge.slow_rows(rows, delay_ms)");
  });

  test("scalars in an empty editor are SELECTed", () => {
    const s = functionCallable("c", func("area", [arg("geom")], "SCALAR", "s"));
    expect(buildCallText(s, { emptyDoc: true })).toBe("SELECT c.s.area(geom)");
  });

  test("named, variadic and trailing optional arguments are left out", () => {
    const args = [
      arg("a"),
      arg("b", { defaultValue: "x", duckdbType: "VARCHAR" }),
      arg("c"),
      arg("d", { defaultValue: "3" }),
      arg("unit", { named: true, positional: false }),
      arg("rest", { isVarargs: true, positional: false }),
    ];
    expect(requiredArgs(args).map((a) => a.name)).toEqual(["a", "b", "c"]);
    const s = functionCallable("c", func("f", args, "SCALAR", "s"));
    expect(buildCallText(s, { emptyDoc: false })).toBe("c.s.f(a, 'x', c)");
  });

  test("identifiers are quoted only when needed", () => {
    expect(sqlIdentifier("plain_name")).toBe("plain_name");
    expect(sqlIdentifier("has$dollar")).toBe('"has$dollar"');
    expect(sqlIdentifier("order")).toBe('"order"');
    expect(sqlIdentifier('we"ird')).toBe('"we""ird"');
    expect(qualifiedName({ catalog: "my-cat", schema: "main", name: "Fn" })).toBe('"my-cat".main.Fn');
  });

  test("braces in names are escaped for the snippet parser", () => {
    const s = functionCallable("c", func("a{b}", [arg("x{y}")], "SCALAR", "s"));
    expect(buildCallSnippet(s, { emptyDoc: false })).toBe('c.s."a\\{b\\}"(${1:xy})${0}');
  });
});

describe("call context", () => {
  const at = (text: string) => {
    const pos = text.indexOf("|");
    return findCallAtPos(text.replace("|", ""), pos);
  };

  test("first and later arguments", () => {
    expect(at("SELECT * FROM cupola_test.edge.slow_rows(|")).toMatchObject({ nameParts: ["cupola_test", "edge", "slow_rows"], argIndex: 0 });
    expect(at("SELECT * FROM slow_rows(1, |")).toMatchObject({ argIndex: 1, positionalIndex: 1 });
  });

  test("nested calls resolve to the innermost", () => {
    expect(at("SELECT f(a, g(b, |")).toMatchObject({ nameParts: ["g"], argIndex: 1 });
    expect(at("SELECT f(a, g(b), |")).toMatchObject({ nameParts: ["f"], argIndex: 2 });
  });

  test("strings and comments do not count", () => {
    expect(at("SELECT f('a, (b', |")).toMatchObject({ nameParts: ["f"], argIndex: 1 });
    expect(at("SELECT f(a /* , ( */, |")).toMatchObject({ argIndex: 1 });
    expect(at("SELECT f(a -- (,\n, |")).toMatchObject({ argIndex: 1 });
    expect(at("SELECT f('ab|c')")).toBeNull();
  });

  test("named arguments", () => {
    expect(at("SELECT f(1, unit := |")).toMatchObject({ namedArg: "unit", argIndex: 1, positionalIndex: 1 });
    expect(at("SELECT f(unit := 'm', |")).toMatchObject({ argIndex: 1, positionalIndex: 0 });
  });

  test("quoted names and keyword parens", () => {
    expect(at('SELECT "my cat".s."f""x"(|')).toMatchObject({ nameParts: ["my cat", "s", 'f"x'] });
    expect(at("SELECT f(x IN (1, |")).toBeNull();
  });

  test("outside any call", () => {
    expect(at("SELECT f(1) |")).toBeNull();
    expect(at("SELECT f(1); SELECT |")).toBeNull();
  });
});

describe("call name under the pointer", () => {
  test("finds the chain before a paren", () => {
    const doc = "SELECT * FROM cupola_test.edge.slow_rows(1, 2)";
    expect(callNameAt(doc, doc.indexOf("edge") + 1)).toMatchObject({ nameParts: ["cupola_test", "edge", "slow_rows"] });
    expect(callNameAt(doc, 2)).toBeNull();
  });
});

describe("active argument", () => {
  test("positional, named and variadic", async () => {
    const { activeArgIndex } = await import("../../src/lib/editor/cm-catalog-help");
    const c = functionCallable("c", func("f", [arg("a"), arg("rest", { isVarargs: true, positional: false }), arg("unit", { named: true, positional: false })], "SCALAR", "s"));
    expect(activeArgIndex(c, { positionalIndex: 0 })).toBe(0);
    expect(activeArgIndex(c, { positionalIndex: 5 })).toBe(1);
    expect(activeArgIndex(c, { positionalIndex: 0, namedArg: "UNIT" })).toBe(2);
    expect(activeArgIndex(c, { positionalIndex: 0, namedArg: "nope" })).toBe(-1);
  });
});

describe("DuckDB built-ins", () => {
  const builtins = catalog("system", { main: { functions: [func("slow_rows", [arg("x")], "SCALAR", "main"), func("strftime", [arg("ts"), arg("format", { duckdbType: "VARCHAR" })], "SCALAR", "main")] } });
  const cats = [
    catalog("memory", { main: { macros: [macro("slow_rows", ["a"])] } }),
    catalog("cupola_test", { edge: { functions: [slowRows] } }, true),
  ];

  test("rank after the primary catalog and before the others", () => {
    const index = buildCatalogIndex(cats, builtins);
    expect(resolveCallable(index, ["slow_rows"]).map((c) => c.catalog)).toEqual(["cupola_test", "system", "memory"]);
  });

  test("the index is rebuilt when the built-ins arrive", () => {
    const without = buildCatalogIndex(cats);
    const withBuiltins = buildCatalogIndex(cats, builtins);
    expect(withBuiltins).not.toBe(without);
    expect(buildCatalogIndex(cats, builtins)).toBe(withBuiltins);
    expect(resolveCallable(without, ["strftime"])).toHaveLength(0);
  });

  test("insert by bare name", () => {
    const [c] = resolveCallable(buildCatalogIndex(cats, builtins), ["strftime"]);
    expect(buildCallText(c, { emptyDoc: false })).toBe("strftime(ts, format)");
    expect(buildCallText(c, { emptyDoc: true })).toBe("SELECT strftime(ts, format)");
  });
});

describe("long option lists", () => {
  test("named options past the limit fold into a count, except the active one", async () => {
    const { signatureParts, formatSignature } = await import("../../src/lib/function-info");
    const options = Array.from({ length: 10 }, (_, i) => arg(`opt${i}`, { named: true, positional: false }));
    const args = [arg("col0", { duckdbType: "VARCHAR" }), ...options];
    expect(formatSignature("read_csv", args, { isTable: true, columns: [] })).toBe("read_csv(col0 VARCHAR, …10 named options) → TABLE");
    expect(signatureParts(args, 4)).toEqual({ shown: [0, 4], folded: 9 });
    expect(signatureParts(args.slice(0, 4))).toEqual({ shown: [0, 1, 2, 3], folded: 0 });
  });
});
