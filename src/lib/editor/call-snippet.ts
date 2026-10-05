/**
 * What inserting a function or macro into a SQL surface writes. The editor
 * gets a CodeMirror snippet (Tab walks the argument placeholders); the shell
 * gets the same call as plain text.
 *
 * Only the arguments a call cannot do without are written: positional ones up
 * to the last required one. Named (`x := …`) and variadic arguments are left
 * out; signature help lists them while the call is being typed.
 */
import { isBuiltin, type Callable } from "../callable";
import type { FunctionArg } from "../function-info";
import { quoteIdent } from "../duckdb-query";

// Words DuckDB will not take as a bare identifier in a qualified name.
const RESERVED = new Set([
  "all", "and", "any", "array", "as", "asc", "both", "case", "cast", "check", "collate", "column",
  "constraint", "create", "default", "desc", "distinct", "do", "else", "end", "except", "false", "fetch",
  "for", "foreign", "from", "grant", "group", "having", "in", "intersect", "into", "join", "lateral",
  "limit", "not", "null", "offset", "on", "only", "or", "order", "primary", "references", "returning",
  "select", "some", "table", "then", "to", "true", "union", "unique", "user", "using", "when", "where",
  "window", "with",
]);

/** An identifier, quoted only when it has to be. */
export function sqlIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoteIdent(name);
}

/** `catalog.schema.name`, always fully qualified: the shell and editor share
 *  one session, and a `USE` in either changes what a shorter name resolves to.
 *  DuckDB's built-ins are the exception: `system` is always searched, and
 *  `system.main.sum(x)` is only noise. */
export function qualifiedName(c: Pick<Callable, "catalog" | "schema" | "name">): string {
  if (isBuiltin(c)) return sqlIdentifier(c.name);
  return [c.catalog, c.schema, c.name].map(sqlIdentifier).join(".");
}

/** The positional arguments a call must spell out: everything up to and
 *  including the last one without a default. */
export function requiredArgs(args: readonly FunctionArg[]): FunctionArg[] {
  const positional = args.filter((a) => !a.named && !a.isVarargs);
  let last = -1;
  positional.forEach((a, i) => { if (a.defaultValue === undefined) last = i; });
  return positional.slice(0, last + 1);
}

const STRINGY = /^(VARCHAR|TEXT|STRING|UTF8|JSON|DATE|TIME|TIMESTAMP|UUID)/i;

/** Placeholder text for one argument: an optional argument that has to be
 *  written (it precedes a required one) shows its default as a literal. */
function placeholder(arg: FunctionArg): string {
  if (arg.defaultValue === undefined) return arg.name;
  return STRINGY.test(arg.duckdbType) ? `'${arg.defaultValue.replace(/'/g, "''")}'` : arg.defaultValue;
}

/** Escape literal text for CodeMirror's snippet syntax. */
function snippetText(text: string): string {
  return text.replace(/[{}]/g, (b) => `\\${b}`);
}

/** Field text: numbered fields cannot contain braces at all. Numbered fields
 *  rather than named ones, because two fields with the same name are one
 *  field to CodeMirror. */
function field(n: number, text: string): string {
  return `\${${n}:${text.replace(/[{}]/g, "")}}`;
}

export interface CallInsertOptions {
  /** The editor holds nothing yet: write a whole statement. */
  emptyDoc: boolean;
}

/** Plain-text call, e.g. `cat.schema.fn(rows, delay_ms)`, or a full SELECT when
 *  `emptyDoc`. Used by the shell and as the snippet's text. */
export function buildCallText(c: Callable, opts: CallInsertOptions): string {
  const call = `${qualifiedName(c)}(${requiredArgs(c.args).map(placeholder).join(", ")})`;
  if (!opts.emptyDoc) return call;
  return c.isTable ? `SELECT * FROM ${call}` : `SELECT ${call}`;
}

/** CodeMirror snippet template for the same call, each argument a tab stop. */
export function buildCallSnippet(c: Callable, opts: CallInsertOptions): string {
  const fields = requiredArgs(c.args).map((a, i) => field(i + 1, placeholder(a)));
  const call = `${snippetText(qualifiedName(c))}(${fields.join(", ")})`;
  const stmt = !opts.emptyDoc ? call : c.isTable ? `SELECT * FROM ${call}` : `SELECT ${call}`;
  return `${stmt}\${0}`;
}
