/**
 * Regenerates tests/fixtures/attach-option-asts.json: DuckDB's own parse of
 * the evaluation statement (`evaluationSql`) for every expression the legacy attach-options tests feed the allowlist walker
 * (src/lib/attach/legacy-options.ts). The browser engine produces the same
 * JSON through `json_serialize_sql`, so the unit tests check the walker
 * against real parser output rather than hand-written ASTs.
 *
 *   bun scripts/attach-option-asts.ts      # needs the `duckdb` CLI on PATH
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { evaluationSql } from "../src/lib/attach/legacy-options";

const EXPRESSIONS = [
  "42", "-5", "1.5e3", "'hello'", "'it''s'", "true", "NULL",
  "[1, 2, 3]", "{'a': 1, 'b': 'x'}", "MAP {'k': 1}", "'2024-01-01'::DATE",
  "CAST(1 AS INTEGER)", "DATE '2024-01-01'", "INTERVAL 3 DAY", "-(1)",
  "row(1, 'a')", "struct_pack(a := 1)", "list_value(1, 2)", "map(['a'], [1])",
  "[[1], [2, 3]]", "{'a': [1, 2], 'b': {'c': 'd'}}",
  // Refused: not constants.
  "getenv('HOME')", "1 + 2", "(SELECT 1)", "x", "read_text('/etc/passwd')",
  "current_date", "NULL::INTEGER", "1; SELECT 2", "1) AS VARCHAR), (SELECT 1", "[1, getenv('X')]", "CAST(getenv('X') AS VARCHAR)", "upper('a')",
  "'a' || 'b'", "now()", "nextval('s')", "list_value(1, (SELECT 2))",
];

const out: Record<string, unknown> = {};
for (const expr of EXPRESSIONS) {
  const sql = `SELECT json_serialize_sql(${quote(evaluationSql(expr))}) AS j`;
  const run = spawnSync("duckdb", ["-json", "-c", sql], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`duckdb failed for ${expr}: ${run.stderr}`);
  const j = JSON.parse(run.stdout)[0].j;
  out[expr] = typeof j === "string" ? JSON.parse(j) : j;
}
writeFileSync(new URL("../tests/fixtures/attach-option-asts.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${Object.keys(out).length} ASTs`);

function quote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
