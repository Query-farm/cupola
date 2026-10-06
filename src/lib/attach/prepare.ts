/**
 * The engine half of attach options: evaluating legacy expressions and
 * type-checking every value before ATTACH runs.
 *
 * Both run against DuckDB itself, so "valid" means what the VGI extension will
 * accept: a value passes when `TRY_CAST(<text> AS <declared type>)` is not
 * NULL, which is the same cast the extension applies (`DefaultTryCastAs`).
 * The engine is injected (`AttachEngine`) so the logic is unit-tested with a
 * fake.
 */
import { quoteLiteral } from "../duckdb-query";
import {
  checkEvaluationAst,
  evaluationSql,
  parsePlainLiteral,
  type LegacyEntry,
  type OptionProblem,
} from "./legacy-options";
import { missingRequiredOptions, type OptionSpecInfo } from "./options";

export interface AttachEngine {
  /** Run a statement and return its first column's first value, or throw. */
  scalar(sql: string): Promise<unknown>;
  /** Run a prepared statement and return its first column's first value, or throw. */
  scalarPrepared(sql: string, params: unknown[]): Promise<unknown>;
  /** Whether `json_serialize_sql` is available (the json extension loaded). */
  canParse: boolean;
}

export interface EvaluatedOptions {
  values: Record<string, string>;
  problems: OptionProblem[];
}

/** Turn legacy `name expr` entries into text values.
 *
 *  Plain literals convert without the engine. Anything else is accepted only
 *  when DuckDB's own parse of the evaluation statement passes the allowlist;
 *  with no parser available (json failed to load), only plain literals are
 *  accepted. Every refusal is reported, never spliced in. */
export async function evaluateLegacyEntries(
  entries: readonly LegacyEntry[],
  engine: AttachEngine,
): Promise<EvaluatedOptions> {
  const values: Record<string, string> = {};
  const problems: OptionProblem[] = [];
  for (const { name, expr } of entries) {
    const text = `${name} ${expr}`;
    const plain = parsePlainLiteral(expr);
    if (plain !== null) {
      values[name] = plain;
      continue;
    }
    if (!engine.canParse) {
      problems.push({ name, text, reason: "Only plain string and number values are accepted (the SQL parser is unavailable)." });
      continue;
    }
    const sql = evaluationSql(expr);
    let refusal: string | null;
    try {
      const json = await engine.scalar(`SELECT json_serialize_sql(${quoteLiteral(sql)})`);
      refusal = checkEvaluationAst(typeof json === "string" ? JSON.parse(json) : (json as any));
    } catch (error) {
      refusal = `DuckDB could not parse it: ${message(error)}`;
    }
    if (refusal) {
      problems.push({ name, text, reason: refusal });
      continue;
    }
    try {
      const value = await engine.scalar(sql);
      if (value === null || value === undefined) {
        problems.push({ name, text, reason: "It evaluates to NULL; leave the option out instead." });
        continue;
      }
      values[name] = String(value);
    } catch (error) {
      problems.push({ name, text, reason: `It could not be evaluated: ${message(error)}` });
    }
  }
  return { values, problems };
}

/** Check each declared option's value against its type, and every required
 *  option for presence. Undeclared options are left to the extension, which
 *  knows its own built-ins (`pool`, `cache`, `data_version_spec`, …) and
 *  refuses the rest by name. */
export async function validateOptionValues(
  options: Record<string, string>,
  specs: readonly OptionSpecInfo[] | undefined,
  engine: Pick<AttachEngine, "scalarPrepared">,
): Promise<OptionProblem[]> {
  const problems: OptionProblem[] = missingRequiredOptions(options, specs).map((spec) => ({
    name: spec.name,
    text: spec.name,
    reason: `Required${spec.description ? ` (${spec.description})` : ""}, but no value was given.`,
  }));
  for (const [name, value] of Object.entries(options)) {
    const spec = specs?.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!spec?.castType || !isCastableType(spec.castType)) continue;
    let ok: unknown;
    try {
      // `?::VARCHAR`: the value is always text. A bare `?` lets the engine infer
      // the parameter's type from the cast target, and binding 'abc' to an
      // INTEGER parameter then throws, which skipped the check entirely.
      ok = await engine.scalarPrepared(`SELECT TRY_CAST(?::VARCHAR AS ${spec.castType}) IS NOT NULL`, [value]);
    } catch (e) {
      // A type name DuckDB does not take (a display-only mapping) is not the
      // value's fault; the extension's own cast is the final word.
      console.warn(`[attach] could not type-check option ${name} as ${spec.castType}:`, e instanceof Error ? e.message : e);
      continue;
    }
    // BOOLEAN arrives as 0/1 with arrowLosslessConversion (engine open), not
    // false/true; Number() reads both. Null means no answer: not the value's fault.
    if (ok != null && Number(ok) === 0) {
      problems.push({ name, text: name, reason: `Not a valid ${spec.duckdbType}.` });
    }
  }
  return problems;
}

/** A DuckDB type name safe to splice after `AS`: what `arrowTypeToDuckDB`
 *  emits, never arbitrary text. The type comes from the server's spec, so it
 *  is checked like any other input: a simple name with optional `(p, s)` and
 *  `[]` suffixes, or a nested `STRUCT(...)` / `MAP(...)` / `UNION(...)` whose
 *  parentheses close only at the very end, so nothing can follow the type. */
export function isCastableType(type: string): boolean {
  if (/^[A-Za-z_][A-Za-z0-9_ ]*(?:\([0-9, ]*\))?(?:\[\])*$/.test(type)) return true;
  const nested = /^(?:STRUCT|MAP|UNION)(\(.*\))((?:\[\])*)$/.exec(type);
  if (!nested || !/^[A-Za-z0-9_ ,()[\]]*$/.test(nested[1])) return false;
  let depth = 0;
  const body = nested[1];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")" && --depth === 0 && i !== body.length - 1) return false;
  }
  return depth === 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
