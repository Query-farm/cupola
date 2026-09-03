/**
 * Tests for the AI agent's system prompt.
 *
 * These exist because the prompt used to assert things it never checked —
 * a hardcoded `SPATIAL_ENABLED = true`, a literal extension list, a literal
 * DuckDB version — and because it inlined the entire catalog with no size cap.
 * Both are now derived, and both are pinned here.
 *
 * Note there is no `mock.module` stub in this file: extracting the prompt from
 * ai-agent.ts into src/lib/ai/system-prompt.ts left it importing only pure
 * `./tags` plus two type-only imports, so it loads without the VGI/RPC graph.
 * That testability was the point of the extraction.
 */
import { test, expect, describe } from "bun:test";
import { buildSystemPrompt } from "../../src/lib/ai/system-prompt";
import type { EngineInfo } from "../../src/lib/duckdb-engine";

const engine = (over: Partial<EngineInfo> = {}): EngineInfo => ({
  duckdbVersion: "1.5.1",
  loadedExtensions: ["icu", "json", "vgi", "spatial"],
  ...over,
});

/** Catalog with `schemas` schemas x `tables` tables, each carrying a comment
 *  of `commentLen` chars (comments are what make a real catalog large). */
function catalog(schemas: number, tables: number, commentLen = 0): any {
  return {
    catalogName: "demo",
    catalogComment: null,
    catalogTags: {},
    defaultSchema: "s0",
    schemas: Array.from({ length: schemas }, (_, i) => ({
      info: { name: `s${i}`, comment: "", tags: {} },
      tables: Array.from({ length: tables }, (_, j) => ({
        name: `t${j}`,
        comment: "x".repeat(commentLen),
        tags: {},
        columns: new Uint8Array(0),
      })),
      views: [],
      functions: [],
      macros: [],
    })),
  };
}

describe("engine facts are reported, not assumed", () => {
  test("states the DuckDB version the engine actually reported", () => {
    expect(buildSystemPrompt(catalog(1, 1), engine({ duckdbVersion: "1.5.1" })))
      .toContain("connected to a DuckDB 1.5.1 database");
  });

  test("omits a version rather than inventing one before boot", () => {
    const p = buildSystemPrompt(catalog(1, 1), engine({ duckdbVersion: "" }));
    expect(p).toContain("connected to a DuckDB database");
    // The old prompt hardcoded a version; make sure none leaked back in.
    expect(p).not.toMatch(/DuckDB \d+\.\d+\.\d+/);
  });

  test("lists exactly the extensions that loaded", () => {
    const p = buildSystemPrompt(catalog(1, 1), engine({ loadedExtensions: ["icu", "vgi"] }));
    expect(p).toContain("Loaded extensions: icu, vgi");
    expect(p).not.toContain("iceberg");
  });

  test("says so plainly when nothing has loaded yet", () => {
    expect(buildSystemPrompt(catalog(1, 1), engine({ loadedExtensions: [] })))
      .toContain("Loaded extensions: (none reported yet)");
  });
});

describe("spatial guidance is gated on the spatial extension", () => {
  test("included when spatial loaded", () => {
    const p = buildSystemPrompt(catalog(1, 1), engine({ loadedExtensions: ["spatial"] }));
    expect(p).toContain("ST_Area_Spheroid");
    expect(p).toContain("always_xy");
  });

  test("omitted entirely when spatial did NOT load", () => {
    // This is the bug: shell-init tolerates a failed non-required extension and
    // continues, so the prompt could advertise spatial and the model would emit
    // ST_* calls that error.
    const p = buildSystemPrompt(catalog(1, 1), engine({ loadedExtensions: ["icu", "vgi"] }));
    expect(p).not.toContain("ST_Area_Spheroid");
    expect(p).not.toContain("ST_Distance_Spheroid");
    expect(p).not.toContain("Plotting geometry");
  });
});

describe("catalog inventory budget", () => {
  test("a small catalog is listed in full", () => {
    const p = buildSystemPrompt(catalog(2, 3), engine());
    expect(p).toContain("`demo.s1.t2`");
    expect(p).not.toContain("too large to list here");
  });

  test("a large catalog is replaced by a pointer to the tools", () => {
    const p = buildSystemPrompt(catalog(40, 60, 200), engine());
    expect(p).toContain("too large to list here");
    expect(p).toContain("list_tables");
    // A table only present in the inventory must be gone.
    expect(p).not.toContain("`demo.s39.t59`");
  });

  test("the truncated form still names the schemas and the object count", () => {
    const p = buildSystemPrompt(catalog(40, 60, 200), engine());
    expect(p).toContain("2400 objects across 40 schemas");
    expect(p).toContain("demo.s0");
  });

  test("a huge catalog costs a bounded number of characters", () => {
    // The invariant is a bound, not "smaller than some other catalog's prompt"
    // — a wide catalog's truncation notice is legitimately longer than a tiny
    // catalog's full listing. Un-truncated, 40x60 tables with 200-char
    // comments would be ~500KB of prompt.
    const huge = buildSystemPrompt(catalog(40, 60, 200), engine());
    expect(huge.length).toBeLessThan(20_000);
  });

  test("a WIDE catalog doesn't reintroduce the problem via the schema list", () => {
    // 800 schemas: over budget by breadth. The notice must not then list all
    // 800 schema names.
    const wide = buildSystemPrompt(catalog(800, 2, 200), engine());
    expect(wide).toContain("too large to list here");
    expect(wide).toContain("more)");
    expect(wide.length).toBeLessThan(20_000);
  });
});

describe("chart tool guidance", () => {
  test("render_chart guidance appears only when the tool is available", () => {
    const withChart = buildSystemPrompt(catalog(1, 1), engine(), null, true);
    const without = buildSystemPrompt(catalog(1, 1), engine(), null, false);
    expect(withChart).toContain("render_chart");
    expect(without).not.toContain("render_chart");
  });
});

describe("memory catalog", () => {
  test("listed when it holds objects", () => {
    const mem = catalog(1, 1);
    mem.catalogName = "memory";
    expect(buildSystemPrompt(catalog(1, 1), engine(), mem)).toContain("memory (writable memory catalog)");
  });

  test("omitted when empty", () => {
    const mem = catalog(1, 0);
    mem.catalogName = "memory";
    expect(buildSystemPrompt(catalog(1, 1), engine(), mem)).not.toContain("memory (in-memory tables)");
  });
});
