import type { ReportDocumentV1, ReportParameterValue } from "./types";

export interface CompiledReportQuery {
  sql: string;
  params: unknown[];
}

/** Compile $parameter references outside strings/comments to prepared `?`s. */
export function compileReportQuery(
  source: string,
  report: Pick<ReportDocumentV1, "parameters">,
  values: Record<string, ReportParameterValue>,
): CompiledReportQuery {
  const byKey = new Map(report.parameters.map((p) => [p.key, p]));
  const params: unknown[] = [];
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
          sql += list.length ? list.map(() => "?").join(", ") : "NULL";
          params.push(...list);
        } else if (parameter.type === "date_range") {
          if (!part) throw new Error(`Date range $${key} must be referenced as $${key}_start or $${key}_end`);
          const range = value && typeof value === "object" && !Array.isArray(value) ? value as { start: string | null; end: string | null } : { start: null, end: null };
          sql += "?"; params.push(range[part]);
        } else {
          sql += "?"; params.push(value);
        }
        i += match[0].length; continue;
      }
    }
    sql += source[i++];
  }
  return { sql, params };
}
