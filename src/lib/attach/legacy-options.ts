/**
 * Migration of legacy raw `attach_options` text (the `?attach_options=` URL
 * parameter, the `attachOptions` of a stored recent service, the connect
 * form's raw-text fallback) into structured option name → DuckDB text value.
 *
 * The raw text used to be spliced into the ATTACH statement unescaped, so a
 * link could run any SQL. Now nothing from it is executed unless it has been
 * proven to be a single constant:
 *
 *  1. `splitLegacyOptions` splits at top-level commas (respecting quotes and
 *     brackets) into `name expr` pairs and validates each name.
 *  2. `parsePlainLiteral` converts a plain string / number / boolean literal
 *     to its text in JS. Those need no engine and no consent.
 *  3. Anything else is an expression. `evaluationSql` wraps it as
 *     `SELECT CAST((<expr>) AS VARCHAR)`; the engine parses THAT exact text
 *     with `json_serialize_sql`, `checkEvaluationAst` walks the AST against an
 *     allowlist (CONSTANT, CAST, unary minus, and the constructors
 *     `list_value` / `struct_pack` / `map` / `row`), and only then is the same
 *     text run. Checking the statement that runs, rather than the fragment it
 *     was built from, means no quoting trick can make the two differ.
 *
 * Pure apart from types: the engine calls live in `prepare.ts`.
 */

export interface LegacyEntry {
  /** Option name, validated. */
  name: string;
  /** The raw SQL value expression, trimmed. */
  expr: string;
}

export interface OptionProblem {
  /** The option, when the text got far enough to name one. */
  name?: string;
  /** The offending text, for the report. */
  text: string;
  reason: string;
}

export interface LegacySplit {
  entries: LegacyEntry[];
  problems: OptionProblem[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Split raw option text at top-level commas into `name expr` pairs.
 *
 *  Quotes (`'…'` and `"…"`, with doubled-quote escapes) and brackets are
 *  tracked so a comma inside `[1, 2]` or `'a, b'` does not split. A segment
 *  with unbalanced quotes or brackets is refused whole: whatever it was, it is
 *  not a value. A bare name is a flag and means `true`, as in DuckDB. */
export function splitLegacyOptions(raw: string): LegacySplit {
  const entries: LegacyEntry[] = [];
  const problems: OptionProblem[] = [];
  const segments: { text: string; error?: string }[] = [];

  let start = 0;
  let quote: string | null = null;
  const stack: string[] = [];
  let broken: string | undefined;
  const flush = (end: number) => {
    segments.push({ text: raw.slice(start, end).trim(), error: broken ?? (quote ? "an unterminated quote" : stack.length ? "an unclosed bracket" : undefined) });
    start = end + 1;
    broken = undefined;
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) {
        if (raw[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c in CLOSE) stack.push(CLOSE[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) broken ??= "unbalanced brackets";
    } else if (c === "," && stack.length === 0) {
      flush(i);
    }
  }
  if (quote || stack.length || raw.slice(start).trim() || broken) {
    flush(raw.length);
  }

  for (const seg of segments) {
    if (!seg.text) continue;
    if (seg.error) {
      problems.push({ text: seg.text, reason: `Not a valid option: ${seg.error}.` });
      continue;
    }
    const parsed = splitNameAndValue(seg.text);
    if ("reason" in parsed) {
      problems.push({ name: parsed.name, text: seg.text, reason: parsed.reason });
      continue;
    }
    entries.push(parsed);
  }
  return { entries, problems };
}

function splitNameAndValue(text: string): LegacyEntry | { name?: string; reason: string } {
  let name: string;
  let rest: string;
  if (text.startsWith('"')) {
    let i = 1;
    let out = "";
    for (; i < text.length; i++) {
      if (text[i] === '"') {
        if (text[i + 1] === '"') { out += '"'; i++; continue; }
        break;
      }
      out += text[i];
    }
    name = out;
    rest = text.slice(i + 1);
  } else {
    const m = /^[^\s'"([{]+/.exec(text);
    name = m ? m[0] : "";
    rest = text.slice(name.length);
  }
  if (!NAME_RE.test(name)) {
    return { name: name || undefined, reason: "Option names must be letters, digits and underscores, not starting with a digit." };
  }
  const expr = rest.trim();
  if (rest && expr && !/^\s/.test(rest) && !/^['"([{]/.test(expr)) {
    return { name, reason: "Expected a space between the option name and its value." };
  }
  return { name, expr: expr || "true" };
}

/** The text of a plain literal, or null when `expr` is anything else.
 *
 *  Strings (`'it''s'` → `it's`), numbers (`42`, `-1.5`) and booleans. NULL is
 *  not a value an option can take, so it is not plain either; evaluation
 *  refuses it with a reason. */
export function parsePlainLiteral(expr: string): string | null {
  const s = expr.trim();
  if (/^'(?:[^']|'')*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return s.replace(/^\+/, "");
  if (/^(?:true|false)$/i.test(s)) return s.toLowerCase();
  return null;
}

/** The statement that evaluates one expression to its DuckDB text form. */
export function evaluationSql(expr: string): string {
  return `SELECT CAST((${expr}) AS VARCHAR)`;
}

/** Functions an option value may be built from: DuckDB's constructors for
 *  nested values, which are what `[1, 2]`, `{'a': 1}` and `MAP {…}` parse to. */
const ALLOWED_FUNCTIONS = new Set(["list_value", "struct_pack", "map", "row"]);

type Json = Record<string, any>;

/** Whether an expression node (from `json_serialize_sql`) is a constant built
 *  only from allowlisted parts. */
export function isAllowedConstant(node: Json | null | undefined): boolean {
  if (!node || typeof node !== "object") return false;
  switch (node.class) {
    case "CONSTANT":
      return true;
    case "CAST":
      return isAllowedConstant(node.child);
    case "FUNCTION": {
      if (node.catalog || (node.schema && node.schema !== "main")) return false;
      if (node.filter || node.distinct || node.export_state) return false;
      if (node.order_bys?.orders?.length) return false;
      const children: Json[] = Array.isArray(node.children) ? node.children : [];
      const name = String(node.function_name ?? "").toLowerCase();
      const allowed = node.is_operator
        ? name === "-" && children.length === 1
        : ALLOWED_FUNCTIONS.has(name);
      return allowed && children.every(isAllowedConstant);
    }
    default:
      return false;
  }
}

/** Check a `json_serialize_sql` result for `evaluationSql(expr)`: exactly one
 *  plain `SELECT CAST((<allowed constant>) AS VARCHAR)` with nothing else
 *  attached. Returns the reason it was refused, or null when it may run. */
export function checkEvaluationAst(parsed: Json | null | undefined): string | null {
  if (!parsed || typeof parsed !== "object") return "DuckDB could not parse it.";
  if (parsed.error) return `DuckDB could not parse it: ${parsed.error_message ?? "syntax error"}`;
  const statements = parsed.statements;
  if (!Array.isArray(statements) || statements.length !== 1) return "It is more than one statement.";
  const node = statements[0]?.node;
  if (!node || node.type !== "SELECT_NODE") return "It is not a value.";
  if (
    (node.modifiers?.length ?? 0) > 0 ||
    (node.cte_map?.map?.length ?? 0) > 0 ||
    node.from_table?.type !== "EMPTY" ||
    node.where_clause || node.having || node.qualify || node.sample ||
    (node.group_expressions?.length ?? 0) > 0 ||
    (node.group_sets?.length ?? 0) > 0
  ) return "It is a query, not a value.";
  const list = node.select_list;
  if (!Array.isArray(list) || list.length !== 1) return "It is more than one value.";
  const cast = list[0];
  if (cast?.class !== "CAST" || cast.try_cast || cast.cast_type?.id !== "VARCHAR") return "It is not a single value.";
  if (cast.child?.class === "CONSTANT" && cast.child.value?.is_null) return "NULL is not an option value; leave the option out instead.";
  if (!isAllowedConstant(cast.child)) {
    return "Only constants are accepted: literals, casts, negation, and [list], {struct}, MAP and row(...) values.";
  }
  return null;
}
