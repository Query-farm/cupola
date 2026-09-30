import { describe, expect, test } from 'bun:test';
import { classifySetupStatement, isReadOnlySql, normalizeName, runSetupSql, splitStatements, testSetupSql } from '../../src/lib/evidence/setup-test';
import { refreshForAgent, type RefreshProfile } from '../../src/lib/evidence/refresh-profile';

const kind = (sql: string, local = new Set<string>()) => classifySetupStatement(sql, local).kind;

describe('splitStatements', () => {
  test('splits at top-level semicolons only', () => {
    expect(splitStatements(`CREATE TEMP TABLE a AS SELECT 'x;y' AS s; -- note; here
SELECT "odd;name" FROM a /* ; */; SELECT $$a;b$$, $q$;$q$`)).toEqual([
      `CREATE TEMP TABLE a AS SELECT 'x;y' AS s`,
      `-- note; here\nSELECT "odd;name" FROM a /* ; */`,
      'SELECT $$a;b$$, $q$;$q$',
    ]);
  });
  test('drops empty and comment-only statements', () => {
    expect(splitStatements(';;\n-- only a comment\n;  ')).toEqual([]);
    expect(splitStatements("SELECT 'it''s'; ")).toEqual(["SELECT 'it''s'"]);
  });
});

describe('classifySetupStatement', () => {
  test('allows temporary objects and reads', () => {
    expect(classifySetupStatement('CREATE OR REPLACE TEMP TABLE sales AS SELECT 1', new Set())).toEqual({ kind: 'create', object: 'table', name: 'sales' });
    expect(kind('create temporary view v as select 1')).toBe('create');
    expect(kind('CREATE TEMP MACRO m(x) AS x + 1')).toBe('create');
    expect(kind('CREATE TABLE memory.main.t AS SELECT 1')).toBe('create');
    expect(kind('CREATE TABLE IF NOT EXISTS temp.main.t (a INT)')).toBe('create');
    expect(kind('-- lead\nWITH x AS (SELECT 1) SELECT * FROM x')).toBe('read');
    expect(kind("ATTACH ':memory:' AS scratch")).toBe('attach');
  });
  test('refuses what a rollback cannot undo', () => {
    for (const sql of ['SET threads = 1', 'PRAGMA enable_profiling', 'INSTALL spatial', 'LOAD spatial', 'USE demo', 'CREATE TABLE sales AS SELECT 1', 'CREATE SCHEMA s', "ATTACH 'file.db'", "COPY t TO 'x.csv'", 'INSERT INTO demo.main.orders VALUES (1)', 'DROP TABLE orders']) {
      const result = classifySetupStatement(sql, new Set());
      expect(result.kind, sql).toBe('refused');
    }
  });
  test('allows writes to temporary tables the script or session created', () => {
    const local = new Set(['sales']);
    expect(kind('INSERT INTO sales SELECT 2', local)).toBe('write');
    expect(kind('INSERT OR REPLACE INTO sales SELECT 2', local)).toBe('write');
    expect(kind('UPDATE Sales SET a = 1', local)).toBe('write');
    expect(kind('DELETE FROM temp.main.other', local)).toBe('write');
    expect(kind('DROP TABLE IF EXISTS sales', local)).toBe('write');
  });
  test('normalizes quoted and unquoted names', () => {
    expect(normalizeName('Temp.Main."My.Table"')).toBe('temp.main.My.Table');
  });
});

describe('isReadOnlySql', () => {
  test('accepts only reads', () => {
    expect(isReadOnlySql('SELECT 1; FROM t; DESCRIBE t; SUMMARIZE t')).toBe(true);
    expect(isReadOnlySql("SELECT 'DROP TABLE x'")).toBe(true);
    expect(isReadOnlySql('SELECT 1; CREATE TEMP TABLE t AS SELECT 1')).toBe(false);
    expect(isReadOnlySql('-- nothing')).toBe(false);
  });
  test('EXPLAIN ANALYZE is a read only when the statement it runs is', () => {
    expect(isReadOnlySql('EXPLAIN ANALYZE SELECT 1')).toBe(true);
    expect(isReadOnlySql('explain analyse with t AS (SELECT 1) SELECT * FROM t')).toBe(true);
    expect(isReadOnlySql('EXPLAIN (ANALYZE, FORMAT json) FROM t')).toBe(true);
    expect(isReadOnlySql('EXPLAIN CREATE TEMP TABLE t AS SELECT 1')).toBe(true);
    expect(isReadOnlySql('EXPLAIN ANALYZE CREATE TEMP TABLE t AS SELECT 1')).toBe(false);
    expect(isReadOnlySql('EXPLAIN ANALYZE INSERT INTO t VALUES (1)')).toBe(false);
    expect(isReadOnlySql('EXPLAIN (FORMAT json, ANALYZE) DELETE FROM t')).toBe(false);
    expect(isReadOnlySql('EXPLAIN ANALYZE EXPLAIN ANALYZE DELETE FROM t')).toBe(false);
    expect(isReadOnlySql('-- nothing')).toBe(false);
  });
});

describe('testSetupSql', () => {
  test('stops at a refused statement without running it', async () => {
    const ran: string[] = [];
    const result = await testSetupSql('CREATE TEMP TABLE a AS SELECT 1 AS n; SET threads = 1; SELECT 2', { parameters: [] }, {}, async work => work(async sql => { ran.push(sql); return { ok: true, arrowBuffers: [] } as any; }));
    expect(result.ok).toBe(false);
    expect(result.refused?.index).toBe(2);
    expect(ran.some(sql => /SET threads/.test(sql))).toBe(false);
    expect(result.note).toMatch(/rolled back/);
  });
  test('comment-only SQL runs nothing', async () => {
    const result = await testSetupSql('-- nothing yet', { parameters: [] }, {}, () => { throw new Error('should not run'); });
    expect(result).toMatchObject({ ok: true, statements: [] });
  });
});

describe('refreshForAgent', () => {
  test('counts runs per named query', () => {
    const profile: RefreshProfile = { startedAt: 0, finishedAt: 900, outcome: 'done', phases: [{ phase: 'render', start: 10, end: 900 }], queries: [
      { id: 1, phase: 'render', sql: 'SELECT count(*) FROM (SELECT * FROM remote.orders)', startedAt: 10, durationMs: 300, error: null },
      { id: 2, phase: 'render', sql: 'SELECT sum(x) FROM (SELECT * FROM remote.orders)', startedAt: 10, durationMs: 400, error: null },
      { id: 3, phase: 'render', sql: 'SELECT * FROM remote.orders', startedAt: 10, durationMs: 100, error: null, cached: true },
    ] };
    const summary = refreshForAgent(profile, [{ name: 'orders', sql: 'SELECT * FROM remote.orders' }])!;
    expect(summary.byQuery).toEqual([{ name: 'orders', runs: 2, ms: 700 }]);
    expect(summary.totalMs).toBe(900);
    expect(refreshForAgent(null, [])).toBeNull();
  });
});

describe('runSetupSql', () => {
  const report = { parameters: [{ id: 'n', key: 'n', label: 'N', type: 'number' as const, required: false, defaultValue: 3 }] };
  test('runs and reports each statement on its own, with parameters bound', async () => {
    const sent: [string, unknown[]][] = [];
    const steps: { name: string; sql: string; error: string | null }[] = [];
    const started: string[] = [];
    const result = await runSetupSql('CREATE OR REPLACE TEMP TABLE a AS SELECT $n AS n;\n-- then\nINSERT INTO a VALUES ($n + 1);', report, { n: 7 },
      async (sql, params) => { sent.push([sql, params]); return { ok: true }; }, step => steps.push(step), step => started.push(`${step.index}/${step.total} ${step.name}`));
    expect(started).toEqual(['1/2 Dataset SQL · a', '2/2 Dataset SQL · statement 2']);
    expect(result).toEqual({ ok: true });
    expect(sent).toEqual([['CREATE OR REPLACE TEMP TABLE a AS SELECT ? AS n', [7]], ['-- then\nINSERT INTO a VALUES (? + 1)', [7]]]);
    expect(steps.map(step => [step.name, step.error])).toEqual([['Dataset SQL · a', null], ['Dataset SQL · statement 2', null]]);
  });
  test('stops at the first failing statement and reports it', async () => {
    const steps: string[] = [];
    let calls = 0;
    const result = await runSetupSql('SELECT 1; SELECT boom; SELECT 3', report, {},
      async () => ++calls === 2 ? { ok: false, error: 'Binder Error' } : { ok: true }, step => steps.push(`${step.index}:${step.error}`));
    expect(result).toEqual({ ok: false, error: 'Statement 2: Binder Error' });
    expect(calls).toBe(2);
    expect(steps).toEqual(['1:null', '2:Binder Error']);
  });
});
