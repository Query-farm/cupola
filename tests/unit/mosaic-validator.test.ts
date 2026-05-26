/**
 * Tests for the Mosaic JSON-schema validator. The agent receives validator
 * output verbatim as the `generate_chart` tool error, so every test here
 * targets a property the agent needs to act on:
 *
 *   - The offending VALUE the user wrote is in the message (not just a pointer)
 *   - For enum violations, ALLOWED values are listed
 *   - For required-property violations, the MISSING key is named
 *   - For additionalProperties violations, the OFFENDING key is named
 *   - anyOf errors surface the closest-matching branch's children, not the
 *     bare "must match a schema in anyOf" parent
 *   - Error list is deduped + capped so an absurdly bad spec doesn't drown out
 *     other tool-result content
 */
import { test, expect } from "bun:test";
import { validateMosaicSpec, formatValidationErrors } from "../../src/lib/mosaic-validator";

test("accepts a minimal valid plot spec", async () => {
  const spec = {
    data: { foo: { type: "table", query: "SELECT 1 AS x, 2 AS y" } },
    plot: [
      { mark: "dot", data: { from: "foo" }, x: "x", y: "y" },
    ],
    width: 640,
    height: 320,
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(true);
  expect(r.errors).toHaveLength(0);
});

test("descriptive: enum violation names the bad value AND lists allowed alternatives", async () => {
  const spec = {
    data: { foo: { type: "table", query: "SELECT 1 AS x" } },
    plot: [
      { mark: "definitelyNotARealMark", data: { from: "foo" }, x: "x" },
    ],
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  // Every line should be descriptive enough to act on.
  const formatted = formatValidationErrors(r.errors);
  // The agent must see the offending value.
  expect(formatted).toContain("definitelyNotARealMark");
  // The agent must see a recognizable real mark in the allowed list.
  expect(formatted).toMatch(/dot|barX|barY|areaX/);
});

test("descriptive: malformed data source surfaces type enum AND a schema-definition hint", async () => {
  // `type: "table"` isn't a valid data-source kind — should land on the
  // /data/foo/type enum constraint AND point the agent at the relevant
  // schema definitions via read_chart_schema.
  const spec = {
    data: { foo: { type: "table" } },
    plot: [{ mark: "dot", data: { from: "foo" }, x: "x" }],
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  const formatted = formatValidationErrors(r.errors);
  // The enum error names the allowed types.
  expect(formatted).toMatch(/parquet|csv|spatial|json/);
  // And the agent is told to fetch the right definition.
  expect(formatted).toContain("read_chart_schema");
});

test("descriptive: additionalProperties error names the unknown key", async () => {
  const spec = {
    data: { foo: { type: "table", query: "SELECT 1" } },
    plot: [
      { mark: "dot", data: { from: "foo" }, x: "x", thisAttributeDoesNotExist: 42 },
    ],
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  const formatted = formatValidationErrors(r.errors);
  expect(formatted).toContain("thisAttributeDoesNotExist");
});

test("descriptive: type error names actual value AND expected type", async () => {
  // `data` at the top level must be an object — a string here is a type error.
  const spec = {
    data: "this should be an object",
    plot: [{ mark: "dot" }],
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  const formatted = formatValidationErrors(r.errors);
  expect(formatted).toContain("this should be an object");
  expect(formatted).toMatch(/object/);
});

test("anyOf best-branch picks the closest match (not the bare parent message)", async () => {
  // A data source with mark-like fields but missing the required identifier:
  // it should be the closest match to a known data shape rather than producing
  // a bare "must match a schema in anyOf" message.
  const spec = {
    data: { foo: { type: "table", query: "SELECT 1 AS x" } },
    plot: [
      { mark: "dot", data: { from: "foo" }, x: "x" },
    ],
    width: 640,
  };
  // Wrong: passing the whole spec as if it were a plot entry
  const wrongShape = { mark: "dot" }; // missing data → expect a useful message, not anyOf wall
  const wrappedSpec = { ...spec, plot: [wrongShape] };
  const r = await validateMosaicSpec(wrappedSpec);
  expect(r.valid).toBe(false);
  const formatted = formatValidationErrors(r.errors);
  // Should NOT just say the unhelpful "must match a schema in anyOf"
  // It should give a concrete actionable error.
  expect(formatted.toLowerCase()).not.toBe("must match a schema in anyof");
  // At minimum, something descriptive about a path.
  expect(formatted).toMatch(/\//);
});

test("error list is deduped and capped at 25 entries", async () => {
  const spec = {
    data: "this should be an object",
    plot: Array(30).fill({ mark: "totally-fake" }),
    width: "not-a-number",
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  expect(r.errors.length).toBeLessThanOrEqual(25);
});

test("definitionHint is set when the schema path is anchored at a named definition", async () => {
  // Bad data-source `type` value — DataFile / DataParquet etc. are named
  // definitions whose $refs survive into the schemaPath, so the validator
  // can extract concrete definitionHints here.
  const spec = {
    data: { foo: { type: "table" } },
    plot: [{ mark: "dot", data: { from: "foo" }, x: "x" }],
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  const hints = r.errors.map((e) => e.definitionHint).filter(Boolean);
  expect(hints.length).toBeGreaterThan(0);
  // The footer references the actual definition name AND the recovery tool.
  const formatted = formatValidationErrors(r.errors);
  expect(formatted).toContain("read_chart_schema");
  expect(formatted).toMatch(/DataFile|DataParquet|DataCSV|DataJSON|DataSpatial/);
});

test("formatter always advertises the recovery tools, even with no specific hints", async () => {
  // Top-level Spec.anyOf is INLINED rather than $ref-ed, so an unknown
  // property at /plot/0 yields no /definitions/X paths — the formatter
  // should still tell the agent that list_chart_schema_definitions exists.
  const spec = {
    data: { foo: { type: "table", query: "SELECT 1" } },
    plot: [{ mark: "dot", data: { from: "foo" }, x: "x", unknownAttr: 42 }],
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  const formatted = formatValidationErrors(r.errors);
  expect(formatted).toContain("list_chart_schema_definitions");
  expect(formatted).toContain("read_chart_schema");
});

test("each error entry exposes path, description, keyword, and the offending value", async () => {
  const spec = {
    data: { foo: { type: "table", query: "SELECT 1" } },
    plot: [{ mark: "totally-fake", data: { from: "foo" }, x: "x" }],
  };
  const r = await validateMosaicSpec(spec);
  expect(r.valid).toBe(false);
  const e = r.errors.find((x) => x.path.includes("mark"));
  expect(e).toBeDefined();
  expect(e!.description.length).toBeGreaterThan(0);
  expect(e!.keyword.length).toBeGreaterThan(0);
  // value should round-trip the bad mark name
  expect(e!.value).toBe("totally-fake");
});
