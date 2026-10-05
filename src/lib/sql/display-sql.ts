/**
 * SQL as Cupola shows it in a code block, and therefore as Run and Copy hand
 * it on: the editor should receive what the reader saw. Example queries are
 * usually written on one line, and the code block used to format them for
 * display only, so a Run pasted the one-line original into the editor.
 *
 * - SQL that already has line breaks is the author's layout and is kept.
 * - A one-liner is formatted with sql-formatter's DuckDB dialect. Keyword case
 *   is left alone: upper-casing turned a column named `year` into `YEAR`,
 *   which renames the result column of a query that is then run.
 * - The formatted text is used only if it differs from the original in
 *   whitespace alone, so running it can never mean anything different. The
 *   generic `sql` dialect failed on `:=`, struct literals and
 *   `USING SAMPLE 10%`, which is why this one is DuckDB's.
 */
import { format } from "sql-formatter";

const cache = new Map<string, string>();
const CACHE_LIMIT = 500;

const squash = (s: string) => s.replace(/\s+/g, "");

export function displaySql(sql: string): string {
  const source = sql.trim();
  if (source.includes("\n")) return source;
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  let out = source;
  try {
    const formatted = format(source, { language: "duckdb", tabWidth: 2, useTabs: false }).trim();
    if (squash(formatted) === squash(source)) out = formatted;
  } catch {
    // Not something the formatter understands: show it as written.
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(source, out);
  return out;
}
