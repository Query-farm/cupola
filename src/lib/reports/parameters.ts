import type { ReportParameterScope, ReportParameterValue } from "./types";

export interface CompiledReportQuery {
  sql: string;
  params: unknown[];
}

/** Whether SQL contains anything to run: text other than line and block comments,
 *  whitespace and semicolons. DuckDB rejects comment-only SQL with "no statements", so a
 *  setup script someone commented out entirely must be skipped, not executed. Quoted text
 *  counts as SQL even when it looks like a comment (`SELECT '--'`). */
export function hasSqlStatements(sql: string): boolean {
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      if (end === -1) return false;
      i = end;
      continue;
    }
    if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 1;
      continue;
    }
    if (char === ";" || /\s/.test(char)) continue;
    return true;
  }
  return false;
}

/** True when a parameter is unset or set to All: null, empty text, or an empty list. */
export function isAllValue(value: ReportParameterValue | undefined): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

interface TransformHooks {
  /** Called with each referenced parameter key (after `_start`/`_end`/`_all` resolution). */
  onReference?: (key: string) => void;
  /** Called instead of throwing for an unknown `$token`; the token is kept as written. */
  onUnknown?: (token: string) => void;
}

function transformReportQuery(
  source: string,
  report: ReportParameterScope,
  values: Record<string, ReportParameterValue>,
  renderValue: (value: unknown) => string,
  hooks: TransformHooks = {},
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
        // `$key_all` is TRUE when `key` is unset or All, for `($key_all OR col IN ($key))`.
        const all = !byKey.has(token) && token.endsWith("_all") && byKey.has(token.slice(0, -4));
        if (all) key = token.slice(0, -4);
        const parameter = byKey.get(key);
        if (!parameter) {
          if (!hooks.onUnknown) throw new Error(`Unknown report parameter $${token}`);
          hooks.onUnknown(token);
          sql += match[0]; i += match[0].length; continue;
        }
        hooks.onReference?.(key);
        const value = values[key] ?? parameter.defaultValue;
        if (all) {
          sql += renderValue(isAllValue(value));
        } else if (parameter.type === "multi_select") {
          const list = Array.isArray(value) ? value : [];
          sql += list.length ? list.map(renderValue).join(", ") : "NULL";
        } else if (parameter.type === "date_range") {
          if (!part) {
            if (!hooks.onUnknown) throw new Error(`Date range $${key} must be referenced as $${key}_start or $${key}_end`);
            hooks.onUnknown(token); sql += match[0]; i += match[0].length; continue;
          }
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
  report: ReportParameterScope,
  values: Record<string, ReportParameterValue>,
): CompiledReportQuery {
  const params: unknown[] = [];
  const sql = transformReportQuery(source, report, values, (value) => {
    params.push(value);
    return "?";
  });
  return { sql, params };
}

/** The parameters a query references, and any `$tokens` that name no parameter.
 *  Never throws for unknown tokens, so it can drive dependency graphs and lint. */
export function scanReportQuery(
  source: string,
  report: ReportParameterScope,
): { references: string[]; unknown: string[] } {
  const references = new Set<string>();
  const unknown = new Set<string>();
  try {
    transformReportQuery(source, report, {}, () => "?", {
      onReference: (key) => references.add(key),
      onUnknown: (token) => unknown.add(token),
    });
  } catch {
    // Scanning never throws for references; anything else is the binder's to report at run time.
  }
  return { references: [...references], unknown: [...unknown] };
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
  report: ReportParameterScope,
  values: Record<string, ReportParameterValue>,
): string {
  return transformReportQuery(source, report, values, sqlLiteral);
}
