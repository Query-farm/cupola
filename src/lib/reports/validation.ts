import { splitStatements } from "@/lib/editor/sql-statements";
import { validateChartSpec } from "@/lib/ai-tool-executor";
import type { ReportBlock, ReportDocumentV1, ReportOption, ReportParameter, ReportParameterRule, ReportParameterValue } from "./types";

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

/** Parameter references in reader-facing templates. A doubled dollar sign
 * escapes a literal token (for example, $$city renders as $city). */
export function parameterTextTokens(source: string): string[] {
  return [...source.matchAll(/(^|[^$])\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[2]);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isEmptyParameterValue(value: ReportParameterValue): boolean {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return true;
  if (typeof value === "object" && !Array.isArray(value)) return !value.start && !value.end;
  return false;
}

export function validateParameterValue(parameter: ReportParameter, value: ReportParameterValue, options?: ReportOption[]): string | null {
  if (isEmptyParameterValue(value)) {
    return parameter.required ? `${parameter.label} is required.` : null;
  }
  if (parameter.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${parameter.label} must be a finite number.`;
  if (parameter.type === "boolean" && typeof value !== "boolean") return `${parameter.label} must be true or false.`;
  if ((parameter.type === "text" || parameter.type === "date") && typeof value !== "string") return `${parameter.label} must be text.`;
  if (parameter.type === "select" && typeof value !== "string" && typeof value !== "number") return `${parameter.label} must be one option.`;
  if (parameter.type === "multi_select" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) return `${parameter.label} must be a list.`;
  if (parameter.type === "date" && !isIsoDate(value)) return `${parameter.label} must be a valid date.`;
  if (parameter.type === "date_range") {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !("start" in value) || !("end" in value)) return `${parameter.label} must contain a start and end date.`;
    if (value.start && !isIsoDate(value.start)) return `${parameter.label} has an invalid start date.`;
    if (value.end && !isIsoDate(value.end)) return `${parameter.label} has an invalid end date.`;
    if ((parameter.validation?.requireBoth || parameter.required) && (!value.start || !value.end)) return `${parameter.label} requires both a start and end date.`;
    if (value.start && value.end && value.start > value.end) return `${parameter.label} start date must not be after its end date.`;
  }
  const validation = parameter.validation;
  if (parameter.type === "number" && typeof value === "number" && validation) {
    if (typeof validation.min === "number" && value < validation.min) return `${parameter.label} must be at least ${validation.min}.`;
    if (typeof validation.max === "number" && value > validation.max) return `${parameter.label} must be at most ${validation.max}.`;
    if (validation.exclusiveMin !== undefined && value <= validation.exclusiveMin) return `${parameter.label} must be greater than ${validation.exclusiveMin}.`;
    if (validation.exclusiveMax !== undefined && value >= validation.exclusiveMax) return `${parameter.label} must be less than ${validation.exclusiveMax}.`;
    if (validation.integer && !Number.isInteger(value)) return `${parameter.label} must be an integer.`;
    if (validation.step !== undefined) {
      const origin = typeof validation.min === "number" ? validation.min : 0;
      const quotient = (value - origin) / validation.step;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return `${parameter.label} must use increments of ${validation.step}.`;
    }
  }
  if (parameter.type === "text" && typeof value === "string" && validation) {
    if (validation.minLength !== undefined && value.length < validation.minLength) return `${parameter.label} must contain at least ${validation.minLength} characters.`;
    if (validation.maxLength !== undefined && value.length > validation.maxLength) return `${parameter.label} must contain at most ${validation.maxLength} characters.`;
    if (validation.pattern !== undefined) {
      try {
        if (!new RegExp(validation.pattern).test(value)) return `${parameter.label} has an invalid format.`;
      } catch {
        return `${parameter.label} has an invalid validation pattern.`;
      }
    }
  }
  if ((parameter.type === "date" || parameter.type === "date_range") && validation) {
    const dates = parameter.type === "date" ? [value as string] : [(value as { start: string | null; end: string | null }).start, (value as { start: string | null; end: string | null }).end].filter(Boolean) as string[];
    if (typeof validation.min === "string" && dates.some((date) => date < validation.min!)) return `${parameter.label} must not be before ${validation.min}.`;
    if (typeof validation.max === "string" && dates.some((date) => date > validation.max!)) return `${parameter.label} must not be after ${validation.max}.`;
    if (parameter.type === "date_range" && validation.maxSpanDays !== undefined) {
      const range = value as { start: string | null; end: string | null };
      if (range.start && range.end) {
        const span = (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000;
        if (span > validation.maxSpanDays) return `${parameter.label} must span no more than ${validation.maxSpanDays} days.`;
      }
    }
  }
  if (parameter.type === "multi_select" && Array.isArray(value) && validation) {
    if (validation.minSelections !== undefined && value.length < validation.minSelections) return `${parameter.label} requires at least ${validation.minSelections} selections.`;
    if (validation.maxSelections !== undefined && value.length > validation.maxSelections) return `${parameter.label} allows at most ${validation.maxSelections} selections.`;
  }
  if ((parameter.type === "select" || parameter.type === "multi_select") && options) {
    const allowed = new Set(options.map((option) => String(option.value)));
    const selected = Array.isArray(value) ? value : [value];
    if (selected.some((item) => !allowed.has(String(item)))) return `${parameter.label} contains a value that is not currently available.`;
  }
  return null;
}

export interface ReportParameterIssue {
  parameterKey?: string;
  code: string;
  message: string;
}

function ruleValue(values: Record<string, ReportParameterValue>, key: string): unknown {
  const [base, part] = key.split(".", 2);
  const value = values[base];
  return part && value && typeof value === "object" && !Array.isArray(value) ? value[part as "start" | "end"] : value;
}

function ruleMatches(rule: ReportParameterRule, values: Record<string, ReportParameterValue>): boolean {
  const left = ruleValue(values, rule.leftKey);
  const right = rule.rightKey ? ruleValue(values, rule.rightKey) : rule.value;
  if (left == null || left === "" || right == null || right === "") return true;
  const comparableLeft = left as any;
  const comparableRight = right as any;
  if (rule.operator === "equal") return left === right;
  if (rule.operator === "not_equal") return left !== right;
  if (rule.operator === "less_than" || rule.operator === "before") return comparableLeft < comparableRight;
  if (rule.operator === "less_than_or_equal" || rule.operator === "before_or_equal") return comparableLeft <= comparableRight;
  if (rule.operator === "greater_than") return comparableLeft > comparableRight;
  return comparableLeft >= comparableRight;
}

export function validateReportParameterValues(
  report: Pick<ReportDocumentV1, "parameters" | "parameterRules">,
  values: Record<string, ReportParameterValue>,
  optionsByKey: Record<string, ReportOption[] | undefined> = {},
): ReportParameterIssue[] {
  const issues: ReportParameterIssue[] = [];
  for (const parameter of report.parameters) {
    const message = validateParameterValue(parameter, values[parameter.key] ?? parameter.defaultValue, optionsByKey[parameter.key]);
    if (message) issues.push({ parameterKey: parameter.key, code: "invalid_value", message });
  }
  for (const rule of report.parameterRules ?? []) {
    if (!ruleMatches(rule, values)) issues.push({ parameterKey: rule.leftKey.split(".")[0], code: "cross_parameter", message: rule.message });
  }
  return issues;
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
  if (input.refreshIntervalSeconds !== undefined && (
    !Number.isInteger(input.refreshIntervalSeconds)
    || input.refreshIntervalSeconds < 5
    || input.refreshIntervalSeconds > 86_400
  )) errors.push("report.refreshIntervalSeconds must be an integer from 5 to 86400.");
  for (const key of ["createdAt", "updatedAt", "revision"] as const) {
    if (!Number.isFinite(input[key])) errors.push(`report.${key} must be a finite number.`);
  }
  for (const key of ["requiredSources", "parameters", "datasets", "blocks"] as const) requireArray(key);
  if (input.groups !== undefined && !Array.isArray(input.groups)) errors.push("report.groups must be an array.");
  if (input.parameterRules !== undefined && !Array.isArray(input.parameterRules)) errors.push("report.parameterRules must be an array.");
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
    if (parameter.required !== undefined && typeof parameter.required !== "boolean") errors.push(`${path}.required must be a boolean.`);
    if (parameter.description !== undefined && typeof parameter.description !== "string") errors.push(`${path}.description must be a string.`);
    if (parameter.options !== undefined) {
      const optionPath = `${path}.options`;
      if (!isRecord(parameter.options)) errors.push(`${optionPath} must be an object.`);
      else if (parameter.options.kind === "static") {
        if (!Array.isArray(parameter.options.values)) errors.push(`${optionPath}.values must be an array.`);
        else parameter.options.values.forEach((option: unknown, optionIndex: number) => {
          if (!isRecord(option) || typeof option.label !== "string" || !["string", "number"].includes(typeof option.value)) errors.push(`${optionPath}.values[${optionIndex}] must contain a string label and string or number value.`);
        });
      } else if (parameter.options.kind === "dataset") {
        requireString(parameter.options, "datasetId", optionPath);
        requireString(parameter.options, "valueColumn", optionPath);
        if (parameter.options.labelColumn !== undefined && typeof parameter.options.labelColumn !== "string") errors.push(`${optionPath}.labelColumn must be a string.`);
      } else errors.push(`${optionPath}.kind is unsupported.`);
    }
    if (parameter.validation !== undefined && !isRecord(parameter.validation)) errors.push(`${path}.validation must be an object.`);
    if (parameter.validationDataset !== undefined) {
      if (!isRecord(parameter.validationDataset)) errors.push(`${path}.validationDataset must be an object.`);
      else {
        requireString(parameter.validationDataset, "datasetId", `${path}.validationDataset`);
        requireString(parameter.validationDataset, "validColumn", `${path}.validationDataset`);
        if (parameter.validationDataset.messageColumn !== undefined && typeof parameter.validationDataset.messageColumn !== "string") errors.push(`${path}.validationDataset.messageColumn must be a string.`);
      }
    }
  });
  (input.parameterRules ?? []).forEach((rule: unknown, index: number) => {
    const path = `report.parameterRules[${index}]`;
    if (!isRecord(rule)) { errors.push(`${path} must be an object.`); return; }
    requireString(rule, "id", path);
    requireString(rule, "leftKey", path);
    requireString(rule, "message", path);
    if (!["less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal", "equal", "not_equal", "before", "before_or_equal"].includes(rule.operator)) errors.push(`${path}.operator is unsupported.`);
    if ((rule.rightKey === undefined) === (!("value" in rule))) errors.push(`${path} must provide exactly one of rightKey or value.`);
    if (rule.rightKey !== undefined && (typeof rule.rightKey !== "string" || !rule.rightKey.trim())) errors.push(`${path}.rightKey must be a non-empty string.`);
    if ("value" in rule && rule.value !== null && !["string", "number", "boolean"].includes(typeof rule.value)) errors.push(`${path}.value must be a scalar or null.`);
  });
  input.datasets.forEach((dataset: unknown, index: number) => {
    const path = `report.datasets[${index}]`;
    if (!isRecord(dataset)) { errors.push(`${path} must be an object.`); return; }
    requireString(dataset, "id", path);
    requireString(dataset, "name", path);
    requireString(dataset, "sql", path);
    if (dataset.role !== undefined && !["data", "parameter_options", "parameter_validation"].includes(dataset.role)) errors.push(`${path}.role is unsupported.`);
  });
  (input.groups ?? []).forEach((group: unknown, index: number) => {
    const path = `report.groups[${index}]`;
    if (!isRecord(group)) { errors.push(`${path} must be an object.`); return; }
    requireString(group, "id", path);
    requireString(group, "title", path);
    if (group.description !== undefined && typeof group.description !== "string") errors.push(`${path}.description must be a string.`);
    if (group.tone !== undefined && !["neutral", "blue", "green", "amber", "violet", "rose"].includes(group.tone)) errors.push(`${path}.tone is unsupported.`);
    if (group.titleSize !== undefined && !["small", "medium", "large"].includes(group.titleSize)) errors.push(`${path}.titleSize is unsupported.`);
  });
  input.blocks.forEach((block: unknown, index: number) => {
    const path = `report.blocks[${index}]`;
    if (!isRecord(block)) { errors.push(`${path} must be an object.`); return; }
    requireString(block, "id", path);
    if (!["markdown", "kpi", "sparkline", "small_multiples", "bullet", "slopegraph", "range_dot", "table", "chart", "perspective", "map", "ai_narrative"].includes(block.type)) errors.push(`${path}.type is unsupported.`);
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
    if (block.title !== undefined && typeof block.title !== "string") errors.push(`${path}.title must be a string.`);
    if (block.groupId !== undefined && typeof block.groupId !== "string") errors.push(`${path}.groupId must be a string.`);
    if (block.appearance !== undefined) {
      if (!isRecord(block.appearance)) errors.push(`${path}.appearance must be an object.`);
      else {
        const appearance = block.appearance;
        if (appearance.tone !== undefined && !["neutral", "info", "success", "warning", "danger"].includes(appearance.tone)) errors.push(`${path}.appearance.tone is unsupported.`);
        if (appearance.emphasis !== undefined && !["subtle", "prominent"].includes(appearance.emphasis)) errors.push(`${path}.appearance.emphasis is unsupported.`);
        if (appearance.label !== undefined && typeof appearance.label !== "string") errors.push(`${path}.appearance.label must be a string.`);
        if (appearance.rules !== undefined && (!Array.isArray(appearance.rules) || appearance.rules.length > 5)) errors.push(`${path}.appearance.rules must contain at most five rules.`);
        else (appearance.rules ?? []).forEach((rule: unknown, ruleIndex: number) => {
          const rulePath = `${path}.appearance.rules[${ruleIndex}]`;
          if (!isRecord(rule)) { errors.push(`${rulePath} must be an object.`); return; }
          requireString(rule, "column", rulePath);
          requireString(rule, "label", rulePath);
          if (!["less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal", "equal", "not_equal", "between"].includes(rule.operator)) errors.push(`${rulePath}.operator is unsupported.`);
          if (!("value" in rule)) errors.push(`${rulePath}.value is required.`);
          if (!["neutral", "info", "success", "warning", "danger"].includes(rule.tone)) errors.push(`${rulePath}.tone is unsupported.`);
          if (rule.emphasis !== undefined && !["subtle", "prominent"].includes(rule.emphasis)) errors.push(`${rulePath}.emphasis is unsupported.`);
          if (rule.rowMatch !== undefined && !["first", "any", "all"].includes(rule.rowMatch)) errors.push(`${rulePath}.rowMatch is unsupported.`);
          if (["less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal", "between"].includes(rule.operator) && !Number.isFinite(rule.value)) errors.push(`${rulePath}.value must be a finite number for ${rule.operator}.`);
          if (rule.operator === "between" && !Number.isFinite(rule.value2)) errors.push(`${rulePath}.value2 must be a finite number for between.`);
        });
      }
    }
    if (block.type === "kpi" || block.type === "sparkline") requireString(block, "valueColumn", path);
    if (block.type === "sparkline") {
      if (block.showValue !== undefined && typeof block.showValue !== "boolean") errors.push(`${path}.showValue must be a boolean.`);
      if (block.color !== undefined && typeof block.color !== "string") errors.push(`${path}.color must be a string.`);
      if (block.splitColumn !== undefined) requireString(block, "splitColumn", path);
      if (block.splitLabel !== undefined && typeof block.splitLabel !== "string") errors.push(`${path}.splitLabel must be a string.`);
      if (block.splitColor !== undefined && typeof block.splitColor !== "string") errors.push(`${path}.splitColor must be a string.`);
      if ((block.splitLabel !== undefined || block.splitColor !== undefined) && block.splitColumn === undefined) errors.push(`${path}.splitColumn is required when splitLabel or splitColor is set.`);
    }
    if (block.caption !== undefined && typeof block.caption !== "string") errors.push(`${path}.caption must be a string.`);
    if (block.source !== undefined && typeof block.source !== "string") errors.push(`${path}.source must be a string.`);
    if (block.format !== undefined && !["number", "currency", "percent", "text"].includes(block.format)) errors.push(`${path}.format is unsupported.`);
    if (block.type === "small_multiples") {
      for (const key of ["facetColumn", "xColumn", "yColumn"] as const) requireString(block, key, path);
      if (block.xType !== undefined && !["temporal", "quantitative", "ordinal", "nominal"].includes(block.xType)) errors.push(`${path}.xType is unsupported.`);
      if (block.mark !== undefined && !["line", "area", "bar", "point"].includes(block.mark)) errors.push(`${path}.mark is unsupported.`);
      if (block.facetColumns !== undefined && (!Number.isInteger(block.facetColumns) || block.facetColumns < 1 || block.facetColumns > 6)) errors.push(`${path}.facetColumns must be an integer from 1 to 6.`);
      if (block.sharedY !== undefined && typeof block.sharedY !== "boolean") errors.push(`${path}.sharedY must be a boolean.`);
      if (block.referenceValue !== undefined && !Number.isFinite(block.referenceValue)) errors.push(`${path}.referenceValue must be a finite number.`);
      if (block.referenceLabel !== undefined && typeof block.referenceLabel !== "string") errors.push(`${path}.referenceLabel must be a string.`);
      if (block.colorColumn !== undefined && typeof block.colorColumn !== "string") errors.push(`${path}.colorColumn must be a string.`);
    }
    if (block.type === "bullet") {
      for (const key of ["categoryColumn", "valueColumn", "targetColumn"] as const) requireString(block, key, path);
      if (block.rangeColumns !== undefined && (!Array.isArray(block.rangeColumns) || block.rangeColumns.length > 3 || block.rangeColumns.some((column: unknown) => typeof column !== "string" || !column.trim()))) errors.push(`${path}.rangeColumns must contain up to three column names.`);
      if (block.color !== undefined && typeof block.color !== "string") errors.push(`${path}.color must be a string.`);
    }
    if (block.type === "slopegraph") {
      for (const key of ["categoryColumn", "startColumn", "endColumn"] as const) requireString(block, key, path);
      for (const key of ["startLabel", "endLabel", "colorColumn"] as const) if (block[key] !== undefined && typeof block[key] !== "string") errors.push(`${path}.${key} must be a string.`);
    }
    if (block.type === "range_dot") {
      for (const key of ["categoryColumn", "lowColumn", "highColumn"] as const) requireString(block, key, path);
      if (block.valueColumn !== undefined && typeof block.valueColumn !== "string") errors.push(`${path}.valueColumn must be a string.`);
      if (block.color !== undefined && typeof block.color !== "string") errors.push(`${path}.color must be a string.`);
    }
    if (block.type === "chart" && !isRecord(block.spec)) errors.push(`${path}.spec must be a Vega-Lite object.`);
    if (block.type === "table" && block.columns !== undefined && (!Array.isArray(block.columns) || block.columns.some((column: unknown) => typeof column !== "string"))) errors.push(`${path}.columns must contain column names.`);
    if (block.type === "perspective" && block.config !== undefined && !isRecord(block.config)) errors.push(`${path}.config must be an object.`);
    if (block.type === "ai_narrative") {
      requireString(block, "instruction", path);
      if (block.columns !== undefined && (!Array.isArray(block.columns) || block.columns.length > 20 || block.columns.some((column: unknown) => typeof column !== "string" || !column.trim()))) errors.push(`${path}.columns must contain up to 20 column names.`);
      if (block.maxRows !== undefined && (!Number.isInteger(block.maxRows) || block.maxRows < 1 || block.maxRows > 100)) errors.push(`${path}.maxRows must be an integer from 1 to 100.`);
      if (block.refreshPolicy !== undefined && !["manual", "when_data_changes"].includes(block.refreshPolicy)) errors.push(`${path}.refreshPolicy is unsupported.`);
      if (block.snapshot !== undefined) {
        const snapshotPath = `${path}.snapshot`;
        if (!isRecord(block.snapshot)) errors.push(`${snapshotPath} must be an object.`);
        else {
          requireString(block.snapshot, "markdown", snapshotPath);
          requireString(block.snapshot, "dataFingerprint", snapshotPath);
          requireString(block.snapshot, "model", snapshotPath);
          if (!Number.isFinite(block.snapshot.generatedAt)) errors.push(`${snapshotPath}.generatedAt must be a finite number.`);
          if (!Number.isInteger(block.snapshot.rowCount) || block.snapshot.rowCount < 0) errors.push(`${snapshotPath}.rowCount must be a non-negative integer.`);
          if (block.snapshot.truncated !== undefined && typeof block.snapshot.truncated !== "boolean") errors.push(`${snapshotPath}.truncated must be a boolean.`);
        }
      }
    }
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
    const validation = p.validation;
    if (validation) {
      const allowed = p.type === "number" ? new Set(["min", "max", "exclusiveMin", "exclusiveMax", "step", "integer"])
        : p.type === "text" ? new Set(["minLength", "maxLength", "pattern"])
          : p.type === "date" ? new Set(["min", "max"])
            : p.type === "date_range" ? new Set(["min", "max", "requireBoth", "maxSpanDays"])
              : p.type === "multi_select" ? new Set(["minSelections", "maxSelections"])
                : new Set<string>();
      for (const key of Object.keys(validation)) if (!allowed.has(key)) errors.push(`${p.label}: validation.${key} is not supported for ${p.type}.`);
      for (const key of ["min", "max", "exclusiveMin", "exclusiveMax", "step"] as const) {
        if (validation[key] !== undefined && p.type === "number" && !Number.isFinite(validation[key])) errors.push(`${p.label}: validation.${key} must be a finite number.`);
      }
      if (p.type === "number" && typeof validation.min === "number" && typeof validation.max === "number" && validation.min > validation.max) errors.push(`${p.label}: validation.min must not exceed validation.max.`);
      if (validation.step !== undefined && (!Number.isFinite(validation.step) || validation.step <= 0)) errors.push(`${p.label}: validation.step must be greater than zero.`);
      if (validation.integer !== undefined && typeof validation.integer !== "boolean") errors.push(`${p.label}: validation.integer must be a boolean.`);
      if (validation.requireBoth !== undefined && typeof validation.requireBoth !== "boolean") errors.push(`${p.label}: validation.requireBoth must be a boolean.`);
      for (const key of ["minLength", "maxLength", "maxSpanDays", "minSelections", "maxSelections"] as const) {
        if (validation[key] !== undefined && (!Number.isInteger(validation[key]) || validation[key]! < 0)) errors.push(`${p.label}: validation.${key} must be a non-negative integer.`);
      }
      if (validation.minLength !== undefined && validation.maxLength !== undefined && validation.minLength > validation.maxLength) errors.push(`${p.label}: validation.minLength must not exceed validation.maxLength.`);
      if (validation.minSelections !== undefined && validation.maxSelections !== undefined && validation.minSelections > validation.maxSelections) errors.push(`${p.label}: validation.minSelections must not exceed validation.maxSelections.`);
      if (validation.pattern !== undefined) {
        if (typeof validation.pattern !== "string" || validation.pattern.length > 256) errors.push(`${p.label}: validation.pattern must be a string of at most 256 characters.`);
        else try { new RegExp(validation.pattern); } catch { errors.push(`${p.label}: validation.pattern is not a valid regular expression.`); }
      }
      if (p.type === "date" || p.type === "date_range") {
        if (validation.min !== undefined && !isIsoDate(validation.min)) errors.push(`${p.label}: validation.min must be an ISO date.`);
        if (validation.max !== undefined && !isIsoDate(validation.max)) errors.push(`${p.label}: validation.max must be an ISO date.`);
        if (typeof validation.min === "string" && typeof validation.max === "string" && validation.min > validation.max) errors.push(`${p.label}: validation.min must not exceed validation.max.`);
      }
    }
    if (p.options?.kind === "static") {
      const membershipError = validateParameterValue({ ...p, required: false }, p.defaultValue, p.options.values);
      if (membershipError && membershipError !== valueError) errors.push(membershipError);
    }
  }
  const datasetIds = new Set<string>();
  const datasetRelationIds = new Map<string, string>();
  for (const d of report.datasets) {
    takeId(d.id, "Dataset"); datasetIds.add(d.id);
    const relationKey = d.id.toLocaleLowerCase("en-US");
    const conflictingId = datasetRelationIds.get(relationKey);
    if (conflictingId && conflictingId !== d.id) errors.push(`Dataset IDs ${conflictingId} and ${d.id} conflict as SQL relation names.`);
    else datasetRelationIds.set(relationKey, d.id);
    errors.push(...validateReadOnlySql(d.sql).map((e) => `${d.name}: ${e}`));
    for (const token of parameterTokens(d.sql)) {
      const rangeBase = token.replace(/_(?:start|end)$/, "");
      if (!keys.has(token) && !keys.has(rangeBase)) errors.push(`${d.name}: unknown parameter $${token}.`);
      const parameter = report.parameters.find((p) => p.key === token);
      const rangeParameter = report.parameters.find((p) => p.key === rangeBase && p.type === "date_range");
      if (rangeParameter && token === rangeParameter.key) errors.push(`${d.name}: date range $${token} must be referenced as $${token}_start or $${token}_end.`);
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
    if (p.validationDataset && !datasetIds.has(p.validationDataset.datasetId)) errors.push(`${p.label}: validation dataset is missing.`);
    if (p.validationDataset) {
      const source = report.datasets.find((dataset) => dataset.id === p.validationDataset!.datasetId);
      if (source && source.role !== "parameter_validation") errors.push(`${p.label}: validation dataset must have role parameter_validation.`);
    }
  }
  const parameterPath = (path: string): ReportParameter | undefined => report.parameters.find((parameter) => parameter.key === path.split(".")[0]);
  for (const rule of report.parameterRules ?? []) {
    takeId(rule.id, "Parameter rule");
    const left = parameterPath(rule.leftKey);
    if (!left) errors.push(`Parameter rule ${rule.id}: unknown left parameter ${rule.leftKey}.`);
    const leftPart = rule.leftKey.split(".")[1];
    if (leftPart && (left?.type !== "date_range" || !["start", "end"].includes(leftPart))) errors.push(`Parameter rule ${rule.id}: ${rule.leftKey} is not a valid parameter path.`);
    if (rule.rightKey) {
      const right = parameterPath(rule.rightKey);
      if (!right) errors.push(`Parameter rule ${rule.id}: unknown right parameter ${rule.rightKey}.`);
      const rightPart = rule.rightKey.split(".")[1];
      if (rightPart && (right?.type !== "date_range" || !["start", "end"].includes(rightPart))) errors.push(`Parameter rule ${rule.id}: ${rule.rightKey} is not a valid parameter path.`);
    }
  }
  const groupIds = new Set<string>();
  const validateTemplate = (source: string | undefined, label: string) => {
    if (!source) return;
    for (const token of parameterTextTokens(source)) {
      if (keys.has(token)) continue;
      const suffix = /_(label|value|start|end)$/.exec(token)?.[1];
      const base = suffix ? token.slice(0, -(suffix.length + 1)) : token;
      const parameter = report.parameters.find((candidate) => candidate.key === base);
      const validSuffix = parameter && (suffix === "label" || suffix === "value" || ((suffix === "start" || suffix === "end") && parameter.type === "date_range"));
      if (!validSuffix) errors.push(`${label}: unknown parameter $${token}.`);
    }
  };
  for (const group of report.groups ?? []) {
    takeId(group.id, "Group");
    groupIds.add(group.id);
    validateTemplate(group.title, group.title);
    validateTemplate(group.description, group.title);
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
    if (b.groupId && !groupIds.has(b.groupId)) errors.push(`${b.title ?? b.id}: group is missing.`);
    validateTemplate(b.title, b.title ?? b.id);
    if (b.type === "markdown") validateTemplate(b.markdown, b.title ?? b.id);
    if (b.type === "ai_narrative") validateTemplate(b.instruction, b.title ?? b.id);
    if (b.type === "markdown" && b.appearance?.rules?.length) errors.push(`${b.title ?? b.id}: conditional appearance requires a dataset-backed block.`);
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
