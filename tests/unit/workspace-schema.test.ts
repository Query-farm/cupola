/**
 * The published JSON Schema (public/schema/workspace-v1.json) against the
 * validator it describes (src/lib/workspace/spec.ts).
 *
 * A small structural JSON Schema checker lives here rather than a dependency:
 * it implements exactly the keywords the schema uses, and the first test
 * fails if the schema starts using one it doesn't, so a keyword can never be
 * silently ignored.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CATALOG_NAME, MAX_CATALOGS, MAX_TEXT, SERVICE_URL, validateWorkspaceFile } from "../../src/lib/workspace/spec";
import { OPTION_NAME_RE, SECRET_NAME_RE } from "../../src/lib/attach/options";
import { buildWorkspaceFile, WORKSPACE_SCHEMA_URL } from "../../src/lib/workspace/file";
import type { Workspace } from "../../src/lib/workspace/store";

type Schema = Record<string, any>;
const schema: Schema = JSON.parse(readFileSync(join(import.meta.dir, "../../public/schema/workspace-v1.json"), "utf8"));

const KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description",
  "type", "const", "required", "properties", "additionalProperties", "items",
  "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "propertyNames", "not",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function resolve(ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split("/").reduce((node: Schema, key) => node[key], schema);
}

/** Errors for `value` against `s` (empty: valid). */
function check(value: unknown, s: Schema, path = "$"): string[] {
  if (s.$ref) return check(value, resolve(s.$ref), path);
  const errors: string[] = [];
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(value);
    if (!types.some((x) => x === t || (x === "number" && t === "integer"))) return [`${path}: expected ${types.join("|")}, got ${t}`];
  }
  if ("const" in s && JSON.stringify(value) !== JSON.stringify(s.const)) errors.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (typeof value === "string") {
    const len = [...value].length;
    if (s.minLength !== undefined && len < s.minLength) errors.push(`${path}: too short`);
    if (s.maxLength !== undefined && len > s.maxLength) errors.push(`${path}: too long`);
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(value)) errors.push(`${path}: does not match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: too few items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: too many items`);
    if (s.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path}: items not unique`);
    if (s.items) value.forEach((v, i) => errors.push(...check(v, s.items, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in obj)) errors.push(`${path}: missing ${key}`);
    for (const [key, v] of Object.entries(obj)) {
      if (s.propertyNames) errors.push(...check(key, s.propertyNames, `${path}{${key}}`));
      if (s.properties && key in s.properties) errors.push(...check(v, s.properties[key], `${path}.${key}`));
      else if (s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
        else if (typeof s.additionalProperties === "object") errors.push(...check(v, s.additionalProperties, `${path}.${key}`));
      }
    }
  }
  if (s.not && check(value, s.not, path).length === 0) errors.push(`${path}: matches a forbidden form`);
  return errors;
}

function keywordsIn(node: unknown, out = new Set<string>(), underProperties = false): Set<string> {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  for (const [key, child] of Object.entries(node)) {
    if (!underProperties) out.add(key);
    // Under properties/$defs the keys are names, not keywords.
    const names = !underProperties && (key === "properties" || key === "$defs");
    if (names) for (const sub of Object.values(child as object)) keywordsIn(sub, out);
    else if (!underProperties && key !== "const") keywordsIn(child, out);
  }
  return out;
}

/** A case-insensitive regex in the character-class form JSON Schema needs
 *  (ECMA-262 patterns have no `i` flag). */
function caseFold(re: RegExp): string {
  let out = "";
  const src = re.source;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { out += c + src[i + 1]; i++; continue; }
    out += /[a-z]/i.test(c) && re.flags.includes("i") ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
  }
  return out;
}

const minimal = { format: "cupola-workspaces", version: 1, workspaces: [{ catalogs: [{ url: "https://a.example", catalogName: "sales" }] }] };
const full = {
  $schema: WORKSPACE_SCHEMA_URL,
  format: "cupola-workspaces",
  version: 1,
  workspaces: [{
    id: "w1", name: "Finance", defaultCatalogId: "c2", defaultSchema: "main",
    catalogs: [
      { id: "c1", url: "https://a.example/vgi", catalogName: "sales", alias: "sales", options: { region: "eu", limit: 5, flag: true }, secrets: ["api_key"], dataVersionSpec: "v1" },
      { id: "c2", url: "grainlift+https://gw.example", catalogName: "sqlite", alias: "gw", target: "sqlite", options: null, secrets: null },
    ],
  }, { name: null, catalogs: [{ url: "HTTP://b.example", catalogName: "x" }] }],
};

const invalid: [string, unknown][] = [
  ["not an object", []],
  ["wrong format", { ...minimal, format: "other" }],
  ["wrong version", { ...minimal, version: 2 }],
  ["no workspaces", { ...minimal, workspaces: [] }],
  ["workspace not an object", { ...minimal, workspaces: [5] }],
  ["no catalogs", { ...minimal, workspaces: [{ catalogs: [] }] }],
  ["too many catalogs", { ...minimal, workspaces: [{ catalogs: Array.from({ length: MAX_CATALOGS + 1 }, (_, i) => ({ url: "https://a", catalogName: `c${i}` })) }] }],
  ["catalog not an object", { ...minimal, workspaces: [{ catalogs: ["x"] }] }],
  ["bad URL scheme", { ...minimal, workspaces: [{ catalogs: [{ url: "file:///etc/passwd", catalogName: "x" }] }] }],
  ["javascript URL", { ...minimal, workspaces: [{ catalogs: [{ url: "javascript:alert(1)", catalogName: "x" }] }] }],
  ["URL with a space", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a b", catalogName: "x" }] }] }],
  ["URL too long", { ...minimal, workspaces: [{ catalogs: [{ url: `https://${"a".repeat(MAX_TEXT)}`, catalogName: "x" }] }] }],
  ["no catalogName", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a" }] }] }],
  ["blank catalogName", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "   " }] }] }],
  ["catalogName too long", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x".repeat(MAX_CATALOG_NAME + 1) }] }] }],
  ["numeric alias", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x", alias: 5 }] }] }],
  ["options is a list", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x", options: ["a"] }] }] }],
  ["secrets is text", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x", secrets: "api_key" }] }] }],
  ["numeric name", { ...minimal, workspaces: [{ name: 5, catalogs: [{ url: "https://a", catalogName: "x" }] }] }],
  ["numeric id", { ...minimal, workspaces: [{ id: 5, catalogs: [{ url: "https://a", catalogName: "x" }] }] }],
];

/** Accepted by the validator only by dropping something (a warning); the
 *  schema, which describes a file as it should be written, refuses them. */
const repaired: [string, unknown][] = [
  ["credential option", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x", options: { api_key: "s3cret" } }] }] }],
  ["option name with a space", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x", options: { "a b": "1" } }] }] }],
  ["object option value", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x", options: { a: { b: 1 } } }] }] }],
  ["bad secret name", { ...minimal, workspaces: [{ catalogs: [{ url: "https://a", catalogName: "x", secrets: ["a b"] }] }] }],
];

describe("workspace JSON Schema", () => {
  test("uses only keywords the checker implements, and is draft 2020-12 at the published URL", () => {
    const unknown = [...keywordsIn(schema)].filter((k) => !KEYWORDS.has(k));
    expect(unknown).toEqual([]);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(WORKSPACE_SCHEMA_URL);
  });

  test("required fields agree with spec.ts", () => {
    expect(schema.required).toEqual(["format", "version", "workspaces"]);
    expect(schema.$defs.workspace.required).toEqual(["catalogs"]);
    expect(schema.$defs.catalog.required).toEqual(["url", "catalogName"]);
    // Removing any required field makes the validator refuse too.
    for (const key of schema.required) {
      const copy: Record<string, unknown> = { ...minimal };
      delete copy[key];
      expect(validateWorkspaceFile(copy).ok).toBe(false);
    }
    for (const key of schema.$defs.catalog.required) {
      const catalog: Record<string, unknown> = { url: "https://a", catalogName: "x" };
      delete catalog[key];
      expect(validateWorkspaceFile({ ...minimal, workspaces: [{ catalogs: [catalog] }] }).ok).toBe(false);
    }
    expect(validateWorkspaceFile({ ...minimal, workspaces: [{}] }).ok).toBe(false);
  });

  test("constants and patterns are the validator's own", () => {
    expect(schema.properties.format.const).toBe("cupola-workspaces");
    expect(schema.properties.version.const).toBe(1);
    const catalog = schema.$defs.catalog.properties;
    expect(catalog.url.pattern).toBe(caseFold(SERVICE_URL));
    expect(catalog.url.maxLength).toBe(MAX_TEXT);
    expect(catalog.catalogName.maxLength).toBe(MAX_CATALOG_NAME);
    expect(catalog.options.propertyNames.pattern).toBe(OPTION_NAME_RE.source);
    expect(catalog.options.propertyNames.not.pattern).toBe(caseFold(SECRET_NAME_RE));
    expect(catalog.secrets.items.pattern).toBe(OPTION_NAME_RE.source);
    expect(schema.$defs.workspace.properties.catalogs.maxItems).toBe(MAX_CATALOGS);
    for (const key of ["id", "alias", "target", "dataVersionSpec"]) expect(catalog[key].maxLength).toBe(MAX_TEXT);
  });

  test("sample files: valid ones pass both, cleanly", () => {
    for (const sample of [minimal, full]) {
      expect(check(sample, schema)).toEqual([]);
      const result = validateWorkspaceFile(sample);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.warnings).toEqual([]);
    }
  });

  test("an exported file passes the schema", () => {
    const ws: Workspace = {
      id: "w1", name: "Finance", defaultCatalogId: "c1", defaultSchema: "main", createdAt: 1, updatedAt: 1, lastOpenedAt: 1,
      catalogs: [{ id: "c1", url: "https://a.example", catalogName: "sales", alias: "sales", options: { region: "eu" }, color: 3, enabled: false }],
    };
    const { file } = buildWorkspaceFile([ws], () => ["api_key"]);
    expect(check(JSON.parse(JSON.stringify(file)), schema)).toEqual([]);
  });

  test("every file the validator refuses, the schema refuses", () => {
    for (const [label, sample] of invalid) {
      expect({ label, ok: validateWorkspaceFile(sample).ok }).toEqual({ label, ok: false });
      expect({ label, schemaErrors: check(sample, schema).length > 0 }).toEqual({ label, schemaErrors: true });
    }
  });

  test("what the validator repairs with a warning, the schema refuses", () => {
    for (const [label, sample] of repaired) {
      const result = validateWorkspaceFile(sample);
      expect({ label, ok: result.ok, warned: result.ok && result.warnings.length > 0 }).toEqual({ label, ok: true, warned: true });
      expect({ label, schemaErrors: check(sample, schema).length > 0 }).toEqual({ label, schemaErrors: true });
    }
  });
});
