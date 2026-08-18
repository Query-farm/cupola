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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the runtime shape before semantic validation touches nested fields.
 * TypeScript types disappear at the tool/import boundary, so malformed agent
 * JSON must produce an actionable path rather than a destructuring exception.
 */
export function validateReportStructure(input: unknown): string[] {
  if (!isRecord(input)) return ["report must be a JSON object."];
  const errors: string[] = [];
  const requireString = (owner: Record<string, any>, key: string, path: string) => {
    if (typeof owner[key] !== "string" || !owner[key].trim()) errors.push(`${path}.${key} must be a non-empty string.`);
  };
  const requireArray = (key: string) => {
    if (!Array.isArray(input[key])) errors.push(`report.${key} must be an array.`);
  };

  if (input.schemaVersion !== 1) errors.push("report.schemaVersion must be 1.");
  requireString(input, "id", "report");
  requireString(input, "title", "report");
  for (const key of ["createdAt", "updatedAt", "revision"] as const) {
    if (!Number.isFinite(input[key])) errors.push(`report.${key} must be a finite number.`);
  }
  for (const key of ["requiredSources", "parameters", "datasets", "blocks"] as const) requireArray(key);
  if (errors.length) return errors;

  input.requiredSources.forEach((source: unknown, index: number) => {
    const path = `report.requiredSources[${index}]`;
    if (!isRecord(source)) errors.push(`${path} must be an object.`);
    else requireString(source, "catalog", path);
  });
  input.parameters.forEach((parameter: unknown, index: number) => {
    const path = `report.parameters[${index}]`;
    if (!isRecord(parameter)) { errors.push(`${path} must be an object.`); return; }
    requireString(parameter, "id", path);
    requireString(parameter, "key", path);
    requireString(parameter, "label", path);
    if (!["text", "number", "boolean", "date", "date_range", "select", "multi_select"].includes(parameter.type)) errors.push(`${path}.type is unsupported.`);
    if (!("defaultValue" in parameter)) errors.push(`${path}.defaultValue is required.`);
  });
  input.datasets.forEach((dataset: unknown, index: number) => {
    const path = `report.datasets[${index}]`;
    if (!isRecord(dataset)) { errors.push(`${path} must be an object.`); return; }
    requireString(dataset, "id", path);
    requireString(dataset, "name", path);
    requireString(dataset, "sql", path);
  });
  input.blocks.forEach((block: unknown, index: number) => {
    const path = `report.blocks[${index}]`;
    if (!isRecord(block)) { errors.push(`${path} must be an object.`); return; }
    requireString(block, "id", path);
    if (!["markdown", "kpi", "table", "chart", "perspective", "map"].includes(block.type)) errors.push(`${path}.type is unsupported.`);
    if (!isRecord(block.layout)) {
      errors.push(`${path}.layout is required and must be {x, y, w, h}.`);
    } else {
      for (const key of ["x", "y", "w", "h"] as const) {
        if (!Number.isFinite(block.layout[key])) errors.push(`${path}.layout.${key} must be a finite number.`);
      }
    }
    if (block.type === "markdown") {
      if (typeof block.markdown !== "string") errors.push(`${path}.markdown must be a string.`);
    } else {
      requireString(block, "datasetId", path);
    }
    if (block.type === "kpi") requireString(block, "valueColumn", path);
    if (block.type === "chart" && !isRecord(block.spec)) errors.push(`${path}.spec must be a Vega-Lite object.`);
    if (block.type === "table" && block.columns !== undefined && (!Array.isArray(block.columns) || block.columns.some((column: unknown) => typeof column !== "string"))) errors.push(`${path}.columns must contain column names.`);
    if (block.type === "perspective" && block.config !== undefined && !isRecord(block.config)) errors.push(`${path}.config must be an object.`);
    if (block.type === "map") {
      for (const key of ["geometryColumn", "latitudeColumn", "longitudeColumn", "labelColumn", "colorColumn"] as const) {
        if (block[key] !== undefined && typeof block[key] !== "string") errors.push(`${path}.${key} must be a string.`);
      }
      if (block.tooltipColumns !== undefined && (!Array.isArray(block.tooltipColumns) || block.tooltipColumns.some((column: unknown) => typeof column !== "string"))) errors.push(`${path}.tooltipColumns must contain column names.`);
      if (block.palette !== undefined && (!Array.isArray(block.palette) || block.palette.some((color: unknown) => typeof color !== "string"))) errors.push(`${path}.palette must contain color strings.`);
      if (block.style !== undefined && !isRecord(block.style)) errors.push(`${path}.style must be an object.`);
    }
  });
  return errors;
}

export function validateReport(input: unknown): string[] {
  const structureErrors = validateReportStructure(input);
  if (structureErrors.length) return structureErrors;
  const report = input as ReportDocumentV1;
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
    if (b.type === "map") {
      const hasGeometry = typeof b.geometryColumn === "string" && Boolean(b.geometryColumn.trim());
      const hasLatitude = typeof b.latitudeColumn === "string" && Boolean(b.latitudeColumn.trim());
      const hasLongitude = typeof b.longitudeColumn === "string" && Boolean(b.longitudeColumn.trim());
      if (!hasGeometry && !(hasLatitude && hasLongitude)) errors.push(`${b.title ?? b.id}: map requires geometryColumn or both latitudeColumn and longitudeColumn.`);
      if (!hasGeometry && hasLatitude !== hasLongitude) errors.push(`${b.title ?? b.id}: map latitudeColumn and longitudeColumn must be provided together.`);
      if (b.basemap && !["none", "openstreetmap"].includes(b.basemap)) errors.push(`${b.title ?? b.id}: unsupported map basemap.`);
      if (b.tooltipColumns && (!Array.isArray(b.tooltipColumns) || b.tooltipColumns.some((column) => typeof column !== "string" || !column.trim()))) errors.push(`${b.title ?? b.id}: map tooltipColumns must contain column names.`);
      if (b.palette && (!Array.isArray(b.palette) || b.palette.length === 0 || b.palette.length > 20 || b.palette.some((color) => typeof color !== "string" || !color.trim()))) errors.push(`${b.title ?? b.id}: map palette must contain 1–20 colors.`);
      const style = b.style;
      if (style) {
        if (style.opacity !== undefined && (!Number.isFinite(style.opacity) || style.opacity < 0 || style.opacity > 1)) errors.push(`${b.title ?? b.id}: map opacity must be between 0 and 1.`);
        if (style.fillOpacity !== undefined && (!Number.isFinite(style.fillOpacity) || style.fillOpacity < 0 || style.fillOpacity > 1)) errors.push(`${b.title ?? b.id}: map fillOpacity must be between 0 and 1.`);
        if (style.weight !== undefined && (!Number.isFinite(style.weight) || style.weight < 0 || style.weight > 20)) errors.push(`${b.title ?? b.id}: map weight must be between 0 and 20.`);
        if (style.radius !== undefined && (!Number.isFinite(style.radius) || style.radius < 1 || style.radius > 50)) errors.push(`${b.title ?? b.id}: map radius must be between 1 and 50.`);
      }
    }
  }
  return errors;
}
