import type { ReportDocumentV1, ReportParameterValue } from "./types";

export interface CompiledReportQuery {
  sql: string;
  params: unknown[];
}

function transformReportQuery(
  source: string,
  report: Pick<ReportDocumentV1, "parameters">,
  values: Record<string, ReportParameterValue>,
  renderValue: (value: unknown) => string,
): string {
  const byKey = new Map(report.parameters.map((p) => [p.key, p]));
  let sql = "", i = 0, quote: "string" | "identifier" | "line" | "block" | null = null;
  while (i < source.length) {
    if (!quote && source[i] === "'" ) { quote = "string"; sql += source[i++]; continue; }
    if (!quote && source[i] === '"' ) { quote = "identifier"; sql += source[i++]; continue; }
    if (!quote && source[i] === "-" && source[i + 1] === "-") { quote = "line"; sql += source.slice(i, i + 2); i += 2; continue; }
    if (!quote && source[i] === "/" && source[i + 1] === "*") { quote = "block"; sql += source.slice(i, i + 2); i += 2; continue; }
    if (quote === "string") {
      sql += source[i];
      if (source[i] === "'" && source[i + 1] === "'") { sql += source[++i]; }
      else if (source[i] === "'") quote = null;
      i++; continue;
    }
    if (quote === "identifier") {
      sql += source[i];
      if (source[i] === '"' && source[i + 1] === '"') { sql += source[++i]; }
      else if (source[i] === '"') quote = null;
      i++; continue;
    }
    if (quote === "line") { sql += source[i]; if (source[i++] === "\n") quote = null; continue; }
    if (quote === "block") {
      sql += source[i];
      if (source[i] === "*" && source[i + 1] === "/") { sql += source[++i]; quote = null; }
      i++; continue;
    }
    if (source[i] === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(source.slice(i))?.[0];
      if (tag) {
        const close = source.indexOf(tag, i + tag.length);
        const end = close === -1 ? source.length : close + tag.length;
        sql += source.slice(i, end); i = end; continue;
      }
    }
    if (source[i] === "$") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
      if (match) {
        const token = match[1];
        let key = token, part: "start" | "end" | null = null;
        if (token.endsWith("_start") && byKey.get(token.slice(0, -6))?.type === "date_range") { key = token.slice(0, -6); part = "start"; }
        if (token.endsWith("_end") && byKey.get(token.slice(0, -4))?.type === "date_range") { key = token.slice(0, -4); part = "end"; }
        const parameter = byKey.get(key);
        if (!parameter) throw new Error(`Unknown report parameter $${token}`);
        const value = values[key] ?? parameter.defaultValue;
        if (parameter.type === "multi_select") {
          const list = Array.isArray(value) ? value : [];
          sql += list.length ? list.map(renderValue).join(", ") : "NULL";
        } else if (parameter.type === "date_range") {
          if (!part) throw new Error(`Date range $${key} must be referenced as $${key}_start or $${key}_end`);
          const range = value && typeof value === "object" && !Array.isArray(value) ? value as { start: string | null; end: string | null } : { start: null, end: null };
          sql += renderValue(range[part]);
        } else {
          sql += renderValue(value);
        }
        i += match[0].length; continue;
      }
    }
    sql += source[i++];
  }
  return sql;
}

/** Compile $parameter references outside strings/comments to prepared `?`s. */
export function compileReportQuery(
  source: string,
  report: Pick<ReportDocumentV1, "parameters">,
  values: Record<string, ReportParameterValue>,
): CompiledReportQuery {
  const params: unknown[] = [];
  const sql = transformReportQuery(source, report, values, (value) => {
    params.push(value);
    return "?";
  });
  return { sql, params };
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Report parameter numbers must be finite.");
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `'${text.replaceAll("'", "''")}'`;
}

/** Produce a runnable snapshot of a parameterized dataset for the SQL editor. */
export function materializeReportQuery(
  source: string,
  report: Pick<ReportDocumentV1, "parameters">,
  values: Record<string, ReportParameterValue>,
): string {
  return transformReportQuery(source, report, values, sqlLiteral);
}

function displayParameterValue(value: ReportParameterValue, part?: "start" | "end"): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") {
    if (part) return value[part] ?? "";
    const start = value.start ?? "";
    const end = value.end ?? "";
    return start && end ? `${start} – ${end}` : start || end;
  }
  return String(value);
}

/** Replace report parameter tokens in reader-facing text without changing the
 * stored template. Unknown tokens are preserved so ordinary dollar-prefixed
 * text is not silently removed. Date ranges accept both `$key` (a readable
 * range) and the same `$key_start` / `$key_end` tokens used by SQL. */
export function interpolateReportText(
  source: string,
  report: Pick<ReportDocumentV1, "parameters">,
  values: Record<string, ReportParameterValue>,
): string {
  const byKey = new Map(report.parameters.map((parameter) => [parameter.key, parameter]));
  return source.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (token, tokenName: string) => {
    let key = tokenName;
    let part: "start" | "end" | undefined;
    if (tokenName.endsWith("_start") && byKey.get(tokenName.slice(0, -6))?.type === "date_range") {
      key = tokenName.slice(0, -6);
      part = "start";
    } else if (tokenName.endsWith("_end") && byKey.get(tokenName.slice(0, -4))?.type === "date_range") {
      key = tokenName.slice(0, -4);
      part = "end";
    }
    const parameter = byKey.get(key);
    if (!parameter) return token;
    return displayParameterValue(values[key] ?? parameter.defaultValue, part);
  });
}
