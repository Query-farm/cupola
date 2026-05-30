/**
 * Unit tests for the FunctionInfo parsing/formatting helpers in src/lib/service.ts.
 *
 * `FunctionInfo.arguments` and `.output_schema` are serialized Arrow schemas (bytes).
 * These tests build standard Arrow IPC schema bytes (with VGI argument metadata keys and
 * the geoarrow extension name) and run them through the real helpers, so the parse matches
 * runtime exactly — including the geoarrow extension-name → GEOMETRY mapping.
 */
import { test, expect, describe } from "bun:test";
import { Schema, Field, Utf8, Int64, Float64, Binary, RecordBatchStreamWriter, type DataType } from "apache-arrow";
import type { FunctionInfo } from "vgi/client";
import { getFunctionArgs, getFunctionReturn, formatFunctionSignature } from "../../src/lib/function-info";

/** Build an Arrow Field with optional custom metadata. */
function f(name: string, type: DataType, meta?: Record<string, string>): Field {
  return new Field(name, type, true, meta ? new Map(Object.entries(meta)) : undefined);
}

/** Serialize a list of fields into standard Arrow IPC schema bytes (matches how a VGI
 *  server serializes FunctionInfo.arguments / .output_schema). */
function ser(fields: Field[]): Uint8Array {
  const w = new RecordBatchStreamWriter();
  w.reset(undefined, new Schema(fields));
  w.close();
  return w.toUint8Array(true);
}

const GEO = { "ARROW:extension:name": "geoarrow.wkb" };

/** Build a minimal FunctionInfo — only the fields the helpers read. */
function fn(partial: Partial<FunctionInfo>): FunctionInfo {
  return {
    name: "f",
    function_type: "TABLE",
    arguments: ser([]),
    output_schema: new Uint8Array(0),
    ...partial,
  } as FunctionInfo;
}

describe("getFunctionArgs", () => {
  test("parses types (incl. GEOMETRY via extension metadata) and all flags", () => {
    const args = getFunctionArgs(
      fn({
        arguments: ser([
          f("geom", new Binary(), GEO),
          f("dist", new Float64()),
          f("opts", new Utf8(), { vgi_arg: "named" }),
          f("vals", new Int64(), { vgi_varargs: "true" }),
          f("anyarg", new Utf8(), { vgi_type: "any" }),
          f("tbl", new Int64(), { vgi_type: "table" }),
          f("c", new Int64(), { vgi_const: "true" }),
        ]),
      }),
    );

    expect(args.map((a) => a.name)).toEqual(["geom", "dist", "opts", "vals", "anyarg", "tbl", "c"]);
    expect(args[0].duckdbType).toBe("GEOMETRY");
    expect(args[1].duckdbType).toBe("DOUBLE");

    expect(args[2].named).toBe(true);
    expect(args[3].isVarargs).toBe(true);
    expect(args[4].isAnyType).toBe(true);
    expect(args[5].isTableInput).toBe(true);
    expect(args[6].isConst).toBe(true);

    // Positional/default arg has none of the flags set.
    expect(args[1]).toMatchObject({
      named: false,
      isVarargs: false,
      isAnyType: false,
      isTableInput: false,
      isConst: false,
    });
  });

  test("returns [] for a no-arg function (zero-length bytes)", () => {
    expect(getFunctionArgs(fn({ arguments: new Uint8Array(0) }))).toEqual([]);
  });

  test("returns [] for an empty (zero-field) schema", () => {
    expect(getFunctionArgs(fn({ arguments: ser([]) }))).toEqual([]);
  });
});

describe("getFunctionReturn", () => {
  test("parses output columns with types", () => {
    const r = getFunctionReturn(
      fn({ output_schema: ser([f("id", new Int64()), f("g", new Binary(), GEO)]) }),
    );
    expect(r.isTable).toBe(true);
    expect(r.columns.map((c) => [c.name, c.duckdbType])).toEqual([
      ["id", "BIGINT"],
      ["g", "GEOMETRY"],
    ]);
  });

  test("present-but-empty output schema yields { columns: [], isTable: true }", () => {
    expect(getFunctionReturn(fn({ output_schema: ser([]) }))).toEqual({ columns: [], isTable: true });
  });

  test("absent output schema yields empty columns", () => {
    expect(getFunctionReturn(fn({ output_schema: new Uint8Array(0) })).columns).toEqual([]);
  });

  test("isTable is false for scalar functions", () => {
    expect(getFunctionReturn(fn({ function_type: "SCALAR", output_schema: ser([f("r", new Float64())]) })).isTable).toBe(false);
  });
});

describe("formatFunctionSignature", () => {
  test("no args + empty table output → name() → TABLE", () => {
    expect(formatFunctionSignature(fn({ name: "f", arguments: new Uint8Array(0), output_schema: ser([]) }))).toBe("f() → TABLE");
  });

  test("positional + named args with a typed table output", () => {
    const sig = formatFunctionSignature(
      fn({
        name: "st_buffer",
        arguments: ser([f("geom", new Binary(), GEO), f("dist", new Float64()), f("opts", new Utf8(), { vgi_arg: "named" })]),
        output_schema: ser([f("id", new Int64()), f("buffer", new Binary(), GEO)]),
      }),
    );
    expect(sig).toBe("st_buffer(geom GEOMETRY, dist DOUBLE, opts := VARCHAR) → TABLE(id BIGINT, buffer GEOMETRY)");
  });

  test("varargs gets a trailing ... on that arg only", () => {
    expect(
      formatFunctionSignature(fn({ name: "concat", arguments: ser([f("vals", new Utf8(), { vgi_varargs: "true" })]), output_schema: ser([]) })),
    ).toBe("concat(vals VARCHAR...) → TABLE");
  });

  test("ANY and table-input render as ANY / TABLE", () => {
    expect(
      formatFunctionSignature(
        fn({ name: "agg", arguments: ser([f("x", new Utf8(), { vgi_type: "any" }), f("t", new Int64(), { vgi_type: "table" })]), output_schema: ser([]) }),
      ),
    ).toBe("agg(x ANY, t TABLE) → TABLE");
  });

  test("scalar function renders a single return type", () => {
    expect(
      formatFunctionSignature(fn({ name: "sqrt", function_type: "SCALAR", arguments: ser([f("x", new Float64())]), output_schema: ser([f("r", new Float64())]) })),
    ).toBe("sqrt(x DOUBLE) → DOUBLE");
  });
});
