import { compileReportQuery, hasSqlStatements } from '../reports/parameters';
import { decodeArrowBuffer } from '../duckdb-query';
import type { QueryResult } from '../shell-bridge';
import { evidenceResult } from './haybarn-query-service';
import { compilerParameters, type EvidenceReport, type ParameterValues } from './reports';

/** Split SQL into statements at top-level semicolons, respecting strings, quoted
 *  identifiers, comments and dollar-quoted bodies. Statements keep their own text. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0, i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      i++;
      while (i < sql.length) { if (sql[i] === char) { if (sql[i + 1] === char) { i += 2; continue; } break; } i++; }
      i++; continue;
    }
    if (char === '-' && sql[i + 1] === '-') { const end = sql.indexOf('\n', i); i = end === -1 ? sql.length : end + 1; continue; }
    if (char === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end === -1 ? sql.length : end + 2; continue; }
    if (char === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) { const end = sql.indexOf(tag, i + tag.length); i = end === -1 ? sql.length : end + tag.length; continue; }
    }
    if (char === ';') { out.push(sql.slice(start, i)); start = i + 1; }
    i++;
  }
  out.push(sql.slice(start));
  return out.filter(hasSqlStatements).map(statement => statement.trim());
}

/** A statement's words, without comments or quoted text (quoted identifiers keep their text). */
function words(statement: string): string[] {
  const code = statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  return code.match(/"(?:[^"]|"")*"(?:\."(?:[^"]|"")*"|\.[A-Za-z_][\w$]*)*|[A-Za-z_][\w$]*(?:\.(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*))*|\S/g) ?? [];
}
const upper = (word: string | undefined) => (word ?? '').toUpperCase();
/** A relation name as DuckDB resolves it: unquoted parts fold to lower case. */
export function normalizeName(name: string): string {
  return name.split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(part => part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.toLowerCase()).join('.');
}
/** Names in `temp` or `memory` live in this browser session, so a rollback undoes them. */
const isLocal = (name: string) => /^(temp|memory)\./.test(normalizeName(name));

const READ = new Set(['SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE', 'DESCRIBE', 'SHOW', 'SUMMARIZE', 'EXPLAIN']);

export type SetupStatement =
  | { kind: 'read' }
  | { kind: 'create'; object: string; name: string }
  | { kind: 'write'; name: string }
  | { kind: 'attach' }
  | { kind: 'refused'; reason: string };

/** What a setup statement does, and whether a rolled-back dry run can undo it. `local` holds
 *  the temp relations that exist (or that earlier statements created). Only what the rollback
 *  tests proved transactional is allowed: settings, installs and writes to the attached remote
 *  catalog would outlive the rollback. */
export function classifySetupStatement(statement: string, local: Set<string>): SetupStatement {
  const w = words(statement);
  const first = upper(w[0]);
  if (READ.has(first)) return { kind: 'read' };
  if (first === 'CREATE') {
    let at = 1;
    if (upper(w[at]) === 'OR' && upper(w[at + 1]) === 'REPLACE') at += 2;
    const temp = upper(w[at]) === 'TEMP' || upper(w[at]) === 'TEMPORARY';
    if (temp) at++;
    const object = upper(w[at]);
    if (!['TABLE', 'VIEW', 'MACRO', 'FUNCTION', 'SEQUENCE', 'TYPE'].includes(object)) {
      return { kind: 'refused', reason: `CREATE ${object || 'this object'} isn't something the dry run can undo safely.` };
    }
    at++;
    if (upper(w[at]) === 'IF' && upper(w[at + 1]) === 'NOT' && upper(w[at + 2]) === 'EXISTS') at += 3;
    const name = w[at];
    if (!name) return { kind: 'refused', reason: 'This CREATE statement names nothing.' };
    if (!temp && !isLocal(name)) {
      return { kind: 'refused', reason: `CREATE ${object} ${name} without TEMP would write to the attached catalog on the server, which a rollback can't undo. Use CREATE TEMP ${object} (the report's setup should create temporary objects anyway).` };
    }
    return { kind: 'create', object: object.toLowerCase(), name };
  }
  const target = (name: string | undefined, verb: string): SetupStatement => {
    if (!name) return { kind: 'refused', reason: `This ${verb} statement names no table.` };
    const normalized = normalizeName(name);
    if (isLocal(name) || local.has(normalized) || local.has(normalized.split('.').at(-1)!)) return { kind: 'write', name };
    return { kind: 'refused', reason: `${verb} ${name} writes to a table that isn't a temporary table in this session; only temporary tables can be changed in a dry run.` };
  };
  if (first === 'INSERT') return target(upper(w[1]) === 'OR' ? w[4] : w[2], 'INSERT INTO');
  if (first === 'UPDATE') return target(w[1], 'UPDATE');
  if (first === 'DELETE') return target(w[2], 'DELETE FROM');
  if (first === 'TRUNCATE') return target(upper(w[1]) === 'TABLE' ? w[2] : w[1], 'TRUNCATE');
  if (first === 'DROP') {
    const object = upper(w[1]);
    if (!['TABLE', 'VIEW', 'MACRO', 'FUNCTION', 'SEQUENCE', 'TYPE'].includes(object)) return { kind: 'refused', reason: `DROP ${object} isn't something the dry run can undo safely.` };
    const at = upper(w[2]) === 'IF' ? 4 : 2;
    return target(w[at], `DROP ${object}`);
  }
  if (first === 'ATTACH') {
    const path = /^\s*ATTACH\s+(?:DATABASE\s+)?(?:IF\s+NOT\s+EXISTS\s+)?'([^']*)'/i.exec(statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' '))?.[1];
    return path === ':memory:' ? { kind: 'attach' } : { kind: 'refused', reason: "Only ATTACH ':memory:' can be tried in a dry run; attaching a file or remote database isn't undone by a rollback." };
  }
  if (['SET', 'RESET', 'PRAGMA', 'USE', 'INSTALL', 'LOAD', 'FORCE', 'CALL'].includes(first)) {
    return { kind: 'refused', reason: `${first} changes the session outside the transaction, so a dry run can't undo it. Keep settings out of the report's setup SQL.` };
  }
  return { kind: 'refused', reason: `${first || 'This statement'} isn't something the dry run knows how to undo safely.` };
}

/** Whether one statement only reads. EXPLAIN ANALYZE runs the statement it explains, so it
 *  reads only when that statement does; plain EXPLAIN runs nothing. */
function isReadStatement(statement: string): boolean {
  const w = words(statement);
  const first = upper(w[0]);
  if (!READ.has(first)) return false;
  if (first !== 'EXPLAIN') return true;
  // EXPLAIN ANALYZE <statement>, or EXPLAIN (ANALYZE[, FORMAT json]) <statement>.
  let at = 1;
  let analyze = false;
  if (w[at] === '(') {
    const close = w.indexOf(')', at);
    if (close === -1) return false;
    analyze = w.slice(at + 1, close).some(word => /^ANALY[SZ]E$/i.test(word));
    at = close + 1;
  } else if (/^ANALY[SZ]E$/i.test(w[at] ?? '')) {
    analyze = true;
    at++;
  }
  const inner = upper(w[at]);
  return !analyze || (READ.has(inner) && inner !== 'EXPLAIN');
}

/** Whether SQL only reads: every statement is a SELECT-like query. The report agent's
 *  run_sql is held to this, so exploring data can never change the report's session. */
export function isReadOnlySql(sql: string): boolean {
  const statements = splitStatements(sql);
  return statements.length > 0 && statements.every(isReadStatement);
}

export interface SetupTestResult {
  ok: boolean;
  durationMs: number;
  statements: { index: number; sql: string; durationMs: number; ok: boolean; error?: string }[];
  refused?: { index: number; sql: string; reason: string };
  tables: { name: string; kind: string; columns?: { name: string; type: string }[]; rowCount?: number; sample?: Record<string, unknown>[]; error?: string }[];
  note: string;
}

type Runner = <T>(work: (run: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<T>;
const excerpt = (sql: string) => sql.length > 400 ? `${sql.slice(0, 400)}…` : sql;
const rowsOf = (result: QueryResult) => result.ok && result.arrowBuffers?.length ? evidenceResult(decodeArrowBuffer(result.arrowBuffers[0])).rows : [];
const ROLLED_BACK = 'Dry run: everything was rolled back, so the session is unchanged. Nothing was proposed or applied.';

/** Run setup SQL as a dry run: statement by statement with the report's parameter values
 *  bound, inside one exclusive transaction that is always rolled back, then describe every
 *  object it created. Stops at the first refused or failing statement. */
export async function testSetupSql(sql: string, report: Pick<EvidenceReport, 'parameters'>, values: ParameterValues, rolledBack: Runner, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SetupTestResult> {
  const started = performance.now();
  const statements = splitStatements(sql);
  if (!statements.length) return { ok: true, durationMs: 0, statements: [], tables: [], note: 'The setup SQL has no statements (only comments or nothing), so nothing runs before the report.' };
  return rolledBack(async run => {
    const result: SetupTestResult = { ok: true, durationMs: 0, statements: [], tables: [], note: ROLLED_BACK };
    const existing = await run("SELECT table_name AS name FROM duckdb_tables() WHERE temporary UNION ALL SELECT view_name FROM duckdb_views() WHERE temporary");
    const local = new Set(rowsOf(existing).map(row => String(row.name).toLowerCase()));
    const created: { name: string; object: string }[] = [];
    for (const [index, statement] of statements.entries()) {
      const kind = classifySetupStatement(statement, local);
      if (kind.kind === 'refused') {
        result.ok = false;
        result.refused = { index: index + 1, sql: excerpt(statement), reason: kind.reason };
        break;
      }
      const start = performance.now();
      let outcome: QueryResult;
      try {
        const compiled = compileReportQuery(statement, compilerParameters(report, values), values);
        outcome = await run(compiled.sql, compiled.params);
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      result.statements.push({ index: index + 1, sql: excerpt(statement), durationMs: Math.round(performance.now() - start), ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
      if (!outcome.ok) { result.ok = false; break; }
      if (kind.kind === 'create') {
        local.add(normalizeName(kind.name).split('.').at(-1)!);
        if (!created.some(item => normalizeName(item.name) === normalizeName(kind.name))) created.push({ name: kind.name, object: kind.object });
      }
    }
    for (const { name, object } of result.ok ? created : []) {
      if (object !== 'table' && object !== 'view') { result.tables.push({ name, kind: object }); continue; }
      const columns = await run(`DESCRIBE ${name}`);
      const count = await run(`SELECT count(*) AS n FROM ${name}`);
      const sample = await run(`SELECT * FROM ${name} LIMIT 5`);
      if (!columns.ok || !count.ok || !sample.ok) { result.tables.push({ name, kind: object, error: columns.error || count.error || sample.error }); continue; }
      result.tables.push({
        name, kind: object,
        columns: rowsOf(columns).map(row => ({ name: String(row.column_name), type: String(row.column_type) })),
        rowCount: Number(rowsOf(count)[0]?.n ?? 0),
        sample: rowsOf(sample),
      });
    }
    result.durationMs = Math.round(performance.now() - started);
    return result;
  }, { timeoutMs: 120_000, ...options });
}

export interface SetupStatementRun { index: number; sql: string; name: string; startedAt: number; durationMs: number; error: string | null }

/** Run a report's setup SQL for a refresh, one statement at a time with parameters bound, so
 *  each statement can be timed on its own (the Performance tab). Stops at the first failure. */
export async function runSetupSql(sql: string, report: Pick<EvidenceReport, 'parameters'>, values: ParameterValues,
  query: (sql: string, params: unknown[]) => Promise<QueryResult>, observe: (run: SetupStatementRun) => void = () => {}): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const [index, statement] of splitStatements(sql).entries()) {
    const kind = classifySetupStatement(statement, new Set());
    const name = `Dataset SQL · ${kind.kind === 'create' ? kind.name : `statement ${index + 1}`}`;
    const startedAt = performance.now();
    let error: string | null;
    try {
      const compiled = compileReportQuery(statement, compilerParameters(report, values), values);
      const outcome = await query(compiled.sql, compiled.params);
      error = outcome.ok ? null : outcome.error || 'Dataset setup failed';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      observe({ index: index + 1, sql: statement, name, startedAt, durationMs: performance.now() - startedAt, error });
      throw e;
    }
    observe({ index: index + 1, sql: statement, name, startedAt, durationMs: performance.now() - startedAt, error });
    if (error) return { ok: false, error: `Statement ${index + 1}: ${error}` };
  }
  return { ok: true };
}
