import { describe, expect, test } from 'bun:test';
import { tableFromArrays, tableToIPC } from '@query-farm/apache-arrow';
import {
  newNotebook,
  newCell,
  duplicateCell,
  defaultChart,
  notebookSchema,
  importNotebook,
  listNotebooks,
  saveNotebook,
  storageKey,
  type SqlCell,
} from '../../src/lib/notebooks/model';
import {
  NotebookRunner,
  isStale,
  validateCellSql,
  validateSelectQuery,
  parseCellSql,
  upstreamInputs,
  type CellResult,
} from '../../src/lib/notebooks/execution';
import { chartData, chartSpec, CHART_ROW_LIMIT } from '../../src/lib/notebooks/charts';
import { notebookProposal, applyNotebookProposal } from '../../src/lib/notebooks/agent';

function storage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => items.clear(),
  };
}
const cell = (id: string, source = 'select 1'): SqlCell => ({
  ...(newCell('sql') as SqlCell),
  id,
  source,
});
const response = () => ({
  ok: true,
  arrowBuffers: [tableToIPC(tableFromArrays({ value: [42] })).slice().buffer as ArrayBuffer],
});

describe('notebook documents', () => {
  test('scopes storage to each connection, preserves unreadable entries, and imports as a new document', () => {
    const saved = storage();
    const a = newNotebook('https://a'),
      b = { ...newNotebook('https://b'), id: a.id };
    saveNotebook(a, saved);
    saveNotebook(b, saved);
    saved.setItem(storageKey(a.serviceUrl, 'broken'), '{broken');
    expect(listNotebooks(a.serviceUrl, saved)).toEqual({
      documents: [a],
      unreadable: 1,
    });
    expect(saved.getItem(storageKey(a.serviceUrl, 'broken'))).toBe('{broken');
    const imported = importNotebook(JSON.stringify(a), b.serviceUrl);
    expect(imported.id).not.toBe(a.id);
    expect(imported.serviceUrl).toBe(b.serviceUrl);
    expect(imported.cells).toEqual(a.cells);
  });
  test('rejects future formats, duplicate identifiers and embedded runtime outputs', () => {
    const doc = newNotebook('a');
    expect(() => notebookSchema.parse({ ...doc, version: 2 })).toThrow();
    expect(() => notebookSchema.parse({ ...doc, cells: [doc.cells[0], doc.cells[0]] })).toThrow('Duplicate');
    expect(() => notebookSchema.parse({ ...doc, results: [] })).toThrow();
    const sql = cell('sql');
    sql.charts = [{ ...defaultChart([]), id: sql.id }];
    expect(() => notebookSchema.parse({ ...doc, cells: [sql] })).toThrow('Duplicate');
  });
  test('duplicates cells with new chart identities', () => {
    const sql = cell('sql');
    sql.charts = [defaultChart([])];
    const clone = duplicateCell(sql) as SqlCell;
    expect(clone.id).not.toBe(sql.id);
    expect(clone.charts[0].id).not.toBe(sql.charts[0].id);
    expect(clone.source).toBe(sql.source);
  });
  test('reports storage failures without erasing prior saved documents', () => {
    const saved = storage(),
      doc = newNotebook('a');
    saveNotebook(doc, saved);
    const original = saved.getItem(storageKey('a', doc.id));
    saved.setItem = () => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    };
    expect(() => saveNotebook({ ...doc, title: 'changed' }, saved)).toThrow('Storage full');
    expect(saved.getItem(storageKey('a', doc.id))).toBe(original);
  });
});

describe('notebook execution', () => {
  test('native validation binds submitted SQL as data and refuses parser errors and multiple statements', async () => {
    let bound: unknown[] = [];
    const parsed = (value: unknown) => ({
      ok: true,
      arrowBuffers: [
        tableToIPC(tableFromArrays({ parsed: [JSON.stringify(value)] })).slice().buffer as ArrayBuffer,
      ],
    });
    await validateSelectQuery("select 'quoted'", async (sql, params) => {
      expect(sql).toBe('SELECT json_serialize_sql(?) AS parsed');
      bound = params;
      return parsed({ error: false, statements: [{}] });
    });
    expect(bound).toEqual(["select 'quoted'"]);
    await expect(
      validateSelectQuery('WITH t AS (select 1) DELETE FROM sales', async () =>
        parsed({
          error: true,
          error_message: 'Only SELECT statements are supported',
        }),
      ),
    ).rejects.toThrow('one SELECT query');
    await expect(
      validateSelectQuery('select 1; select 2', async () => parsed({ error: false, statements: [{}, {}] })),
    ).rejects.toThrow('one SELECT query');
  });
  test('accepts one read query and refuses scripts or writes', () => {
    for (const sql of ["select ';' as value;", 'with x as (select 1) select * from x', '-- note\nselect 1'])
      expect(() => validateCellSql(sql)).not.toThrow();
    for (const sql of [
      '',
      '-- only a comment',
      'select 1; select 2',
      'delete from sales',
      'create table x as select 1',
      'EXPLAIN ANALYZE DELETE FROM sales',
    ])
      expect(() => validateCellSql(sql)).toThrow();
  });
  test('accepts only connection-local CREATE TABLE AS queries and safely quotes names', () => {
    for (const sql of [
      'create temp table x as select 1',
      'CREATE OR REPLACE TEMPORARY TABLE x AS WITH t AS (SELECT 1) SELECT * FROM t;',
      '-- setup\nCREATE /* note */ TEMP TABLE "x.y" AS VALUES (1)',
    ]) expect(() => validateCellSql(sql)).not.toThrow();
    expect(parseCellSql('create temp table "a""b" as select 1')).toEqual({
      table: 'a"b', query: 'select 1', sql: 'CREATE TEMP TABLE "a""b" AS\nselect 1',
    });
    for (const sql of [
      'create table x as select 1',
      'create temp table memory.main.x as select 1',
      'create temp view x as select 1',
      'create temp table x (id integer)',
      'create temp table x as select 1; delete from sales',
      'create temp table x as delete from sales',
      'create temp table x as select 1; create temp table y as select 2',
    ]) expect(() => validateCellSql(sql)).toThrow();
  });
  test('downstream freshness tracks upstream SQL, bound parameters and table replacements', () => {
    const setup = cell('setup', 'CREATE OR REPLACE TEMP TABLE totals AS SELECT $n AS n');
    const consumer = cell('consumer', 'SELECT * FROM totals');
    const scope = { cells: [setup, consumer], parameters: [{ id: 'n', key: 'n', label: 'N', type: 'number' as const, defaultValue: 2, required: false }] };
    const result = { source: consumer.source, table: tableFromArrays({ n: [2] }), upstreamInputs: upstreamInputs(consumer.id, scope) };
    expect(isStale(consumer, result, scope)).toBe(false);
    expect(isStale(consumer, result, { ...scope, values: { n: 3 } })).toBe(true);
    expect(isStale(consumer, result, { ...scope, cells: [{ ...setup, source: 'SELECT 1' }, consumer] })).toBe(true);
    expect(isStale(consumer, { ...result, dependencyStale: true }, scope)).toBe(true);
  });
  test('running only a consumer cannot make an unexecuted setup edit look fresh', async () => {
    const setup = cell('setup', 'CREATE OR REPLACE TEMP TABLE totals AS SELECT 42 AS n');
    const consumer = cell('consumer', 'SELECT * FROM totals');
    const results: Record<string, CellResult> = {};
    const runner = new NotebookRunner(async () => response(), (id, update) => {
      results[id] = { ...results[id], ...update };
    });
    const scope = { cells: [setup, consumer] };
    await runner.run(scope.cells, scope);
    expect(isStale(consumer, results.consumer, scope)).toBe(false);
    const changed = { cells: [{ ...setup, source: setup.source.replace('42', '80') }, consumer] };
    await runner.run([consumer], changed);
    expect(isStale(consumer, results.consumer, changed)).toBe(true);
    await runner.run(changed.cells, changed);
    expect(isStale(consumer, results.consumer, changed)).toBe(false);
    runner.reset();
    await runner.run([consumer], changed);
    expect(results.consumer.provenance?.number).toBe(1);
    expect(results.consumer.history).toHaveLength(1);
    expect(isStale(consumer, results.consumer, changed)).toBe(true);
  });
  test('consumers of derived tables stay stale until every changed setup is rebuilt', async () => {
    const setup = cell('setup', 'CREATE OR REPLACE TEMP TABLE totals AS SELECT 42 AS n');
    const derived = cell('derived', 'CREATE OR REPLACE TEMP TABLE doubled AS SELECT n * 2 AS n FROM totals');
    const consumer = cell('consumer', 'SELECT * FROM doubled');
    const scope = { cells: [setup, derived, consumer] };
    const results: Record<string, CellResult> = {};
    const runner = new NotebookRunner(async () => response(), (id, update) => {
      results[id] = { ...results[id], ...update };
    });
    await runner.run(scope.cells, scope);
    await runner.run([setup], scope);
    await runner.run([consumer], scope);
    expect(isStale(consumer, results.consumer, scope)).toBe(true);
    // Displayed outputs may be cleared without losing table lineage.
    delete results.setup;
    delete results.derived;
    await runner.run([consumer], scope);
    expect(isStale(consumer, results.consumer, scope)).toBe(true);
    await runner.run([derived, consumer], scope);
    expect(isStale(consumer, results.consumer, scope)).toBe(false);
  });
  test('runs in document order, stops on error and preserves the previous table', async () => {
    const calls: string[] = [],
      results: Record<string, CellResult> = {};
    const runner = new NotebookRunner(
      async (sql) => {
        calls.push(sql);
        return sql === 'select fail' ? { ok: false, error: 'missing column' } : response();
      },
      (id, update) => {
        results[id] = { ...results[id], ...update };
      },
    );
    await runner.run([cell('one')]);
    const table = results.one.table;
    await runner.run([cell('one', 'select fail'), cell('two', 'select 2')]);
    expect(calls).toEqual(['select 1', 'select fail']);
    expect(results.one.table).toBe(table);
    expect(results.one.error).toBe('missing column');
    expect(isStale(cell('one'), results.one)).toBe(true);
    expect(runner.running).toBe(false);
  });
  test('cancel forwards the signal, ignores late success and skips later cells', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    let signal!: AbortSignal;
    const results: Record<string, CellResult> = {};
    const runner = new NotebookRunner(
      async (_sql, nextSignal) => {
        signal = nextSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      (id, update) => {
        results[id] = { ...results[id], ...update };
      },
    );
    const pending = runner.run([cell('one'), cell('two')]);
    await runner.run([cell('overlapping')]);
    runner.stop();
    expect(signal.aborted).toBe(true);
    finish(response());
    await pending;
    expect(results.one.cancelled).toBe(true);
    expect(results.one.table).toBeUndefined();
    expect(results.two).toBeUndefined();
    expect(results.overlapping).toBeUndefined();
  });
  test('results track the executed source even if the cell is edited during a run', async () => {
    let result: CellResult = {};
    const runner = new NotebookRunner(
      async () => response(),
      (_id, update) => {
        result = { ...result, ...update };
      },
    );
    await runner.run([cell('one', 'select 1')]);
    expect(result.table?.numRows).toBe(1);
    expect(isStale(cell('one', 'select 2'), result)).toBe(true);
    expect(isStale(cell('one', 'select 1'), result)).toBe(false);
  });
});

describe('notebook charts', () => {
  test('bounds conversion and exposes preview truncation', () => {
    const table = tableFromArrays({
      x: Array.from({ length: CHART_ROW_LIMIT + 1 }, (_, i) => i),
    });
    const data = chartData(table);
    expect(data.rows).toHaveLength(CHART_ROW_LIMIT);
    expect(data.truncated).toBe(true);
    expect(chartData(table.slice(0, 1)).truncated).toBe(false);
  });
  test('validates changed schemas, escapes literal SQL names and only aggregates histograms', () => {
    const columns = [
      { name: 'sales.month', numeric: false, temporal: false },
      { name: 'amount', numeric: true, temporal: false },
    ];
    const chart = defaultChart(columns);
    const spec = chartSpec(chart, columns) as any;
    expect(spec.encoding.x.field).toBe('sales\\.month');
    expect(spec.encoding.y.aggregate).toBeUndefined();
    const grouped = chartSpec({ ...chart, color: 'sales.month' }, columns) as any;
    expect(grouped.encoding.xOffset.field).toBe('sales\\.month');
    expect(() => chartSpec(chart, columns.slice(0, 1))).toThrow('missing column');
    expect(() => chartSpec({ ...chart, y: 'sales.month' }, columns)).toThrow('numeric Y');
    const histogram = chartSpec({ ...chart, type: 'histogram', x: 'amount' }, columns) as any;
    expect(histogram.encoding.y.aggregate).toBe('count');
    expect(histogram.encoding.x.bin).toBe(true);
  });
});

describe('notebook AI edits', () => {
  test('rejects proposals after user edits and allows unchanged documents', () => {
    const doc = newNotebook('a');
    const proposal = notebookProposal(
      doc,
      { summary: 'Rename', title: 'Analysis', cells: doc.cells },
      'unrestricted-sql',
    );
    expect(applyNotebookProposal(doc, proposal).title).toBe('Analysis');
    expect(() => applyNotebookProposal({ ...doc, title: 'My edit' }, proposal)).toThrow('changed after');
    expect(doc.title).toBe('Untitled notebook');
  });
  test('semantic-only mode allows prose and chart edits but rejects new SQL', () => {
    const doc = newNotebook('a');
    expect(() =>
      notebookProposal(
        doc,
        {
          summary: 'Notes',
          title: doc.title,
          cells: [...doc.cells, newCell('markdown')],
        },
        'semantic-only',
      ),
    ).not.toThrow();
    expect(() =>
      notebookProposal(doc, { summary: 'Query', title: doc.title, cells: [cell('new')] }, 'semantic-only'),
    ).toThrow('raw SQL');
  });
});

test('AI rejects unchanged proposals regardless of cell property order', () => {
  const doc = newNotebook('a');
  const original = doc.cells[0];
  const { type, ...rest } = original;
  const reordered = { type, ...rest };
  expect(() =>
    notebookProposal(doc, { summary: 'No edits', title: doc.title, cells: [reordered] }, 'unrestricted-sql'),
  ).toThrow('no changes');
});

test('new charts preserve SQL result order and older explicit sorting remains valid', () => {
  const columns = [
    { name: 'month', numeric: false, temporal: false },
    { name: 'revenue', numeric: true, temporal: false },
  ];
  const chart = defaultChart(columns);
  expect((chartSpec(chart, columns) as any).encoding.x.sort).toBeNull();
  expect((chartSpec({ ...chart, sort: 'ascending' }, columns) as any).encoding.x.sort).toBe('ascending');
  const doc = newNotebook('a');
  (doc.cells[0] as SqlCell).charts.push({ ...chart, sort: 'descending' });
  expect(() => notebookSchema.parse(doc)).not.toThrow();
});
