/**
 * Catalog alias references in SQL: finding them, and rewriting them when a
 * catalog's alias changes (the alias-rename dialog) or a report written for
 * one alias is opened where the same catalog has another (Rebind).
 *
 * A tokenizer, not a regex over raw text. Text the tokenizer sees as a string
 * literal (`'…'` with `''` escapes, `E'…'` with backslash escapes, `$$…$$` /
 * `$tag$…$tag$` dollar quotes), a comment (`--`, nested `/* *\/`), a
 * prepared parameter (`$country`, `$1`) or an Evidence `${query}`
 * interpolation is never a reference.
 *
 * What counts as a reference to catalog `sales` (DuckDB folds identifiers
 * case-insensitively, quoted ones included, so `SALES` and `"Sales"` match):
 *
 * - `sales.schema.table` (and longer chains): three or more dotted parts
 *   starting with the alias. A two-part name is ambiguous in general:
 * - `sales.table` counts only in a relation position, i.e. right after
 *   `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `VIEW`, `DESCRIBE`, … or after a
 *   comma inside a FROM clause. Anywhere else `sales.amount` is a table alias
 *   or a column qualifier (`SELECT sales.amount FROM orders AS sales`), and
 *   rewriting it would break the query.
 * - `USE sales` / `DETACH sales`: the bare alias after those keywords.
 *
 * Never a reference: a column named like the alias (`SELECT sales`), the
 * alias as a later part of a chain (`x.sales`, `x.sales.y`), and a different
 * identifier that merely contains it (`other_sales.x`).
 *
 * A rewrite keeps each reference's quoting: a quoted reference stays quoted,
 * a bare one stays bare unless the new alias needs quotes (a keyword, or not
 * a plain identifier).
 *
 * Report sources are Markdoc. Only their ```sql fences are SQL; the prose,
 * `{% %}` tags and other fences are left alone (`report-aliases.ts`).
 *
 * Pure: unit-tested in tests/unit/alias-rewrite.test.ts.
 */

export type SqlTokenKind = "space" | "comment" | "string" | "ident" | "quoted" | "param" | "interp" | "number" | "op";

export interface SqlToken {
  kind: SqlTokenKind;
  start: number;
  end: number;
  /** For `ident`: the text; for `quoted`: the identifier with `""` unescaped. */
  value: string;
}

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/** Split SQL into tokens, covering every character. Unterminated strings,
 *  comments and quoted identifiers run to the end of the text. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  const push = (kind: SqlTokenKind, start: number, end: number, value = sql.slice(start, end)) => {
    tokens.push({ kind, start, end, value });
    i = end;
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1] ?? "";
    const start = i;
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      push("space", start, j);
    } else if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      push("comment", start, nl < 0 ? n : nl);
    } else if (c === "/" && next === "*") {
      // DuckDB's parser (libpg_query) nests block comments.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
        else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      push("comment", start, j);
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      push("string", start, Math.min(j, n));
    } else if ((c === "e" || c === "E") && next === "'") {
      // E'…': backslash escapes as well as ''. (An `e` inside an identifier
      // never starts a token, so this is only ever a standalone prefix.)
      let j = i + 2;
      while (j < n) {
        if (sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      push("string", start, Math.min(j, n));
    } else if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { value += '"'; j += 2; continue; }
          j++;
          break;
        }
        value += sql[j];
        j++;
      }
      push("quoted", start, Math.min(j, n), value);
    } else if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 130));
      if (tag) {
        // Dollar-quoted string: runs to the same tag.
        const close = sql.indexOf(tag[0], i + tag[0].length);
        push("string", start, close < 0 ? n : close + tag[0].length);
      } else if (next === "{") {
        // Evidence's `${query_name}` interpolation.
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          if (sql[j] === "{") depth++;
          else if (sql[j] === "}" && --depth === 0) { j++; break; }
        }
        push("interp", start, Math.min(j, n));
      } else if (next && isIdentPart(next)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
        push("param", start, j);
      } else {
        push("op", start, i + 1);
      }
    } else if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j])) j++;
      push("ident", start, j);
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i));
      push("number", start, i + (m ? m[0].length : 1));
    } else {
      push("op", start, i + 1);
    }
  }
  return tokens;
}

/** Keywords after which a two-part name is a relation (`FROM sales.orders`). */
const RELATION_KEYWORDS = new Set([
  "from", "join", "into", "update", "table", "view", "describe", "summarize", "copy",
  "exists", "pivot", "unpivot", "macro", "function", "sequence", "type", "show", "use",
]);
/** Keywords after which the bare alias is the catalog itself. */
const CATALOG_KEYWORDS = new Set(["use", "detach", "database"]);
/** Keywords that start a FROM clause (commas then separate relations). */
const FROM_START = new Set(["from", "join"]);
/** Keywords that end one. */
const FROM_END = new Set([
  "where", "group", "having", "order", "limit", "offset", "qualify", "window", "union", "except",
  "intersect", "select", "on", "using", "set", "values", "returning", "sample", "to",
]);

/** DuckDB's reserved keywords (`duckdb_keywords()` where category is
 *  reserved): a bare identifier spelled like one must be quoted. */
const RESERVED_KEYWORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "both", "case", "cast",
  "check", "collate", "column", "constraint", "create", "default", "deferrable", "desc", "describe",
  "distinct", "do", "else", "end", "except", "false", "fetch", "for", "foreign", "from", "grant", "group",
  "having", "in", "initially", "intersect", "into", "lateral", "leading", "limit", "not", "null", "offset",
  "on", "only", "or", "order", "pivot", "pivot_longer", "pivot_wider", "placing", "primary", "qualify",
  "references", "returning", "select", "show", "some", "summarize", "symmetric", "table", "then", "to",
  "trailing", "true", "union", "unique", "unpivot", "using", "variadic", "when", "where", "window", "with",
]);

/** Whether `name` must be written `"quoted"` to be read back as itself. */
export function needsQuoting(name: string): boolean {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_KEYWORDS.has(name.toLowerCase());
}

/** `name` as an identifier: bare when that reads back as itself, else quoted. */
export function identifierText(name: string, forceQuotes = false): string {
  return forceQuotes || needsQuoting(name) ? `"${name.replace(/"/g, '""')}"` : name;
}

export interface AliasReference {
  /** Offsets of the identifier token (quotes included) in the text. */
  start: number;
  end: number;
  /** 1-based. */
  line: number;
  column: number;
  /** The reference was written `"quoted"`. */
  quoted: boolean;
  /** The reference as written. */
  text: string;
}

export interface AliasReferences {
  count: number;
  references: AliasReference[];
}

const isName = (t: SqlToken | undefined): t is SqlToken => !!t && (t.kind === "ident" || t.kind === "quoted");
const isOp = (t: SqlToken | undefined, op: string) => !!t && t.kind === "op" && t.value === op;
const keyword = (t: SqlToken | undefined) => (t && t.kind === "ident" ? t.value.toLowerCase() : null);

/** Every token that refers to one of `aliases` (lower-cased) as a catalog. */
function referenceTokens(sql: string, aliases: ReadonlySet<string>): SqlToken[] {
  if (!aliases.size) return [];
  const all = tokenizeSql(sql);
  const sig = all.filter((t) => t.kind !== "space" && t.kind !== "comment");
  const found: SqlToken[] = [];
  // FROM-clause state per parenthesis depth.
  const inFrom: boolean[] = [false];
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    const kw = t.kind === "ident" ? t.value.toLowerCase() : null;
    if (isOp(t, "(")) { inFrom.push(false); continue; }
    if (isOp(t, ")")) { if (inFrom.length > 1) inFrom.pop(); continue; }
    const prev = sig[k - 1];
    if (isName(t) && aliases.has(t.value.toLowerCase()) && !isOp(prev, ".")) {
      // Named parts of the dotted chain this token starts (`a.b.*` has two).
      let parts = 1;
      let j = k;
      while (isOp(sig[j + 1], ".") && isName(sig[j + 2])) { parts++; j += 2; }
      const prevKw = keyword(prev);
      const relation = (prevKw !== null && RELATION_KEYWORDS.has(prevKw)) || (isOp(prev, ",") && inFrom[inFrom.length - 1]);
      if (parts >= 3 || (parts === 2 && relation) || (parts === 1 && !isOp(sig[k + 1], ".") && prevKw !== null && CATALOG_KEYWORDS.has(prevKw))) {
        found.push(t);
      }
    }
    if (kw && FROM_START.has(kw)) inFrom[inFrom.length - 1] = true;
    else if (kw && FROM_END.has(kw)) inFrom[inFrom.length - 1] = false;
  }
  return found;
}

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) if (text[i] === "\n") { line++; lineStart = i + 1; }
  return { line, column: offset - lineStart + 1 };
}

/** References to catalog `alias` in SQL, with their positions. */
export function findAliasReferences(sql: string, alias: string): AliasReferences {
  if (!alias) return { count: 0, references: [] };
  const references = referenceTokens(sql, new Set([alias.toLowerCase()])).map((t) => ({
    start: t.start,
    end: t.end,
    ...position(sql, t.start),
    quoted: t.kind === "quoted",
    text: sql.slice(t.start, t.end),
  }));
  return { count: references.length, references };
}

/** Rewrite several aliases at once (`from` → `to`, compared
 *  case-insensitively), so swapping two aliases works. */
export function rewriteAliases(sql: string, mapping: ReadonlyMap<string, string> | Record<string, string>): { text: string; count: number } {
  const entries = mapping instanceof Map ? [...mapping.entries()] : Object.entries(mapping);
  const lower = new Map(entries.filter(([from, to]) => from && to && from !== to).map(([from, to]) => [from.toLowerCase(), to]));
  const tokens = referenceTokens(sql, new Set(lower.keys()));
  if (!tokens.length) return { text: sql, count: 0 };
  let out = "";
  let at = 0;
  for (const t of tokens) {
    out += sql.slice(at, t.start) + identifierText(lower.get(t.value.toLowerCase())!, t.kind === "quoted");
    at = t.end;
  }
  return { text: out + sql.slice(at), count: tokens.length };
}

/** Rewrite references to catalog `from` as `to`. */
export function rewriteAlias(sql: string, from: string, to: string): string {
  return rewriteAliases(sql, { [from]: to }).text;
}
