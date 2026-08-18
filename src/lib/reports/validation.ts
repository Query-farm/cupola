import { splitStatements } from "@/lib/editor/sql-statements";
import { validateChartSpec } from "@/lib/ai-tool-executor";
import type { ReportBlock, ReportDocumentV1, ReportParameter, ReportParameterValue } from "./types";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_SQL = /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|COPY|ATTACH|DETACH|CALL|PRAGMA|INSTALL|LOAD|EXPORT|IMPORT|VACUUM|CHECKPOINT)\b/i;
const DYNAMIC_SQL = /\bquery\s*\(/i;

export function validateReadOnlySql(sql: string): string[] {
  const errors: string[] = [];
  const statements = splitStatements(sql);
  if (statements.length !== 1) return ["Dataset SQL must contain exactly one statement."];
  const source = stripSqlCommentsAndLiterals(statements[0].text);
  const first = /^\s*([A-Za-z]+)/.exec(source)?.[1]?.toUpperCase();
  if (!first || !["SELECT", "WITH", "VALUES"].includes(first)) {
    errors.push("Dataset SQL must be a SELECT, VALUES, or WITH … SELECT query.");
  }
  if (FORBIDDEN_SQL.test(source)) errors.push("Dataset SQL contains a write, control, or extension-loading statement.");
  if (DYNAMIC_SQL.test(source)) errors.push("Dynamic SQL via query() is not allowed in reports.");
  if (first === "WITH" && !/\b(?:SELECT|VALUES)\b/i.test(source)) errors.push("A WITH query must resolve to SELECT or VALUES.");
  return errors;
}

/** Preserve identifiers/keywords while blanking strings and comments. */
function stripSqlCommentsAndLiterals(sql: string): string {
  let out = "", i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      out += "  "; i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) { out += " "; i++; }
      if (i < sql.length) { out += "  "; i += 2; }
      continue;
    }
    if (sql[i] === "'") {
      out += " "; i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "  "; i += 2; continue; }
        const done = sql[i] === "'"; out += " "; i++; if (done) break;
      }
      continue;
    }
    if (sql[i] === '"') {
      out += " "; i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { out += "  "; i += 2; continue; }
        const done = sql[i] === '"'; out += " "; i++; if (done) break;
      }
      continue;
    }
    if (sql[i] === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        out += " ".repeat(tag.length); i += tag.length;
        const close = sql.indexOf(tag, i);
        const end = close === -1 ? sql.length : close + tag.length;
        out += " ".repeat(end - i); i = end; continue;
      }
    }
    out += sql[i++];
  }
  return out;
}

export function parameterTokens(sql: string): string[] {
  const clean = stripSqlCommentsAndLiterals(sql);
  return [...clean.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
}

export function validateParameterValue(parameter: ReportParameter, value: ReportParameterValue): string | null {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return parameter.required ? `${parameter.label} is required.` : null;
  }
  if (parameter.type === "number" && typeof value !== "number") return `${parameter.label} must be a number.`;
  if (parameter.type === "boolean" && typeof value !== "boolean") return `${parameter.label} must be true or false.`;
  if (parameter.type === "multi_select" && !Array.isArray(value)) return `${parameter.label} must be a list.`;
  if (parameter.type === "date_range" && (typeof value !== "object" || Array.isArray(value) || !("start" in value) || !("end" in value))) {
    return `${parameter.label} must contain a start and end date.`;
  }
  return null;
}

function blockDatasetId(block: ReportBlock): string | null {
  return block.type === "markdown" ? null : block.datasetId;
}

export function validateReport(report: ReportDocumentV1): string[] {
  const errors: string[] = [];
  if (report.schemaVersion !== 1) errors.push("Unsupported report schema version.");
  if (!report.id || !report.title.trim()) errors.push("A report ID and title are required.");
  const ids = new Set<string>();
  const takeId = (id: string, label: string) => {
    if (!id) errors.push(`${label} is missing an ID.`);
    else if (ids.has(id)) errors.push(`Duplicate ID: ${id}.`);
    else ids.add(id);
  };
  const keys = new Set<string>();
  for (const p of report.parameters) {
    takeId(p.id, "Parameter");
    if (!KEY_RE.test(p.key)) errors.push(`Invalid parameter key: ${p.key}.`);
    if (keys.has(p.key)) errors.push(`Duplicate parameter key: ${p.key}.`);
    keys.add(p.key);
    const valueError = validateParameterValue({ ...p, required: false }, p.defaultValue);
    if (valueError) errors.push(valueError);
  }
  const datasetIds = new Set<string>();
  for (const d of report.datasets) {
    takeId(d.id, "Dataset"); datasetIds.add(d.id);
    errors.push(...validateReadOnlySql(d.sql).map((e) => `${d.name}: ${e}`));
    for (const token of parameterTokens(d.sql)) {
      const rangeBase = token.replace(/_(?:start|end)$/, "");
      if (!keys.has(token) && !keys.has(rangeBase)) errors.push(`${d.name}: unknown parameter $${token}.`);
      const parameter = report.parameters.find((p) => p.key === token);
      if (parameter?.type === "multi_select") {
        const clean = stripSqlCommentsAndLiterals(d.sql);
        const occurrences = [...clean.matchAll(new RegExp(`\\$${token}\\b`, "g"))];
        const validOccurrences = [...clean.matchAll(new RegExp(`\\bIN\\s*\\(\\s*\\$${token}\\s*\\)`, "gi"))];
        if (occurrences.length !== validOccurrences.length) errors.push(`${d.name}: multi-select $${token} must be used as IN ($${token}).`);
      }
    }
  }
  for (const p of report.parameters) {
    if (p.options?.kind === "dataset" && !datasetIds.has(p.options.datasetId)) errors.push(`${p.label}: options dataset is missing.`);
  }
  const dependencies = new Map<string, Set<string>>();
  for (const p of report.parameters) {
    const options = p.options;
    if (options?.kind !== "dataset") continue;
    const source = report.datasets.find((d) => d.id === options.datasetId);
    if (!source) continue;
    dependencies.set(p.key, new Set(parameterTokens(source.sql).map((token) => token.replace(/_(?:start|end)$/, ""))));
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const hasCycle = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) if (dependencies.has(dependency) && hasCycle(dependency)) return true;
    visiting.delete(key); visited.add(key); return false;
  };
  if ([...dependencies.keys()].some(hasCycle)) errors.push("SQL-driven parameter choices contain a dependency cycle.");
  for (const b of report.blocks) {
    takeId(b.id, "Block");
    const datasetId = blockDatasetId(b);
    if (datasetId && !datasetIds.has(datasetId)) errors.push(`${b.title ?? b.id}: dataset is missing.`);
    const { x, y, w, h } = b.layout;
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > 12) errors.push(`${b.title ?? b.id}: invalid layout.`);
    if (b.type === "chart") errors.push(...validateChartSpec(b.spec).errors.map((e) => `${b.title ?? b.id}: ${e}`));
  }
  return errors;
}
