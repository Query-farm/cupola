import { describe, expect, test } from 'bun:test';
import { tableFromArrays, tableToIPC } from '@query-farm/apache-arrow';
import { compileNotebookQuery, type NotebookParameter } from '../../src/lib/notebooks/parameters';
import {
  newNotebook,
  notebookSchema,
  importNotebook,
  fingerprint,
  type SqlCell,
} from '../../src/lib/notebooks/model';
import {
  NotebookRunner,
  isStale,
  type CellResult,
  type NotebookRunOptions,
} from '../../src/lib/notebooks/execution';
import { notebookProposal, applyNotebookProposal } from '../../src/lib/notebooks/agent';

const parameter = (
  key = 'region',
  type: NotebookParameter['type'] = 'text',
  defaultValue: NotebookParameter['defaultValue'] = 'west',
): NotebookParameter => ({
  id: key,
  key,
  label: key,
  type,
  defaultValue,
  required: false,
});
const response = () => ({
  ok: true,
  arrowBuffers: [tableToIPC(tableFromArrays({ n: [42] })).slice().buffer as ArrayBuffer],
});
const sqlCell = (source = 'select $region'): SqlCell => ({
  id: 'sql',
  type: 'sql',
  title: 'Query',
  source,
  collapsed: false,
  charts: [],
});

describe('notebook parameters', () => {
  test('binds values, not SQL, and leaves literals, identifiers, dollar strings and comments intact', () => {
    const source = `select $region, $region, '$region', "$region", $$ $region $$ -- $region\n/* $region */`;
    const value = "west'); DROP TABLE sales; --";
    const bound = compileNotebookQuery(source, { parameters: [parameter()], values: { region: value } });
    expect(bound.sql).toBe(`select ?, ?, '$region', "$region", $$ $region $$ -- $region\n/* $region */`);
    expect(bound.params).toEqual([value, value]);
    expect(bound.values).toEqual({ region: value });
  });
  test('preserves numeric/boolean types, dates, dropdown values, and explicit nulls', () => {
    const scope = {
      parameters: [
        parameter('n', 'number', 2),
        parameter('yes', 'boolean', false),
        parameter('day', 'date', '2026-10-05'),
        { ...parameter('region', 'select'), choices: ['west', 'east'] },
      ],
      values: { n: 7, yes: true, region: null },
    };
    expect(compileNotebookQuery('select $n, $yes, $day, $region', scope).params).toEqual([
      7,
      true,
      '2026-10-05',
      null,
    ]);
    expect(() => compileNotebookQuery('select $missing', scope)).toThrow('Unknown notebook parameter');
    expect(() => compileNotebookQuery('select $day', { ...scope, values: { day: '2026-02-30' } })).toThrow(
      'valid date',
    );
    expect(() => compileNotebookQuery('select $region', { ...scope, values: { region: 'missing' } })).toThrow(
      'listed value',
    );
    expect(() =>
      compileNotebookQuery('select $n', {
        parameters: [{ ...parameter('n', 'number', null), required: true }],
      }),
    ).toThrow('required');
    expect(
      compileNotebookQuery('select 1', {
        parameters: [{ ...parameter('n', 'number', null), required: true }],
      }).params,
    ).toEqual([]);
  });
  test('keeps legacy notebooks readable and round-trips definitions and values', () => {
    const legacy = newNotebook('server');
    expect(notebookSchema.parse(legacy)).toEqual(legacy);
    const doc = notebookSchema.parse({ ...legacy, parameters: [parameter()], values: { region: 'east' } });
    const imported = importNotebook(JSON.stringify(doc), 'other');
    expect(imported.parameters).toEqual(doc.parameters);
    expect(imported.values).toEqual(doc.values);
    expect(fingerprint(doc)).not.toBe(fingerprint({ ...doc, values: { region: 'west' } }));
    expect(() =>
      notebookSchema.parse({ ...doc, parameters: [parameter(), { ...parameter(), id: 'another' }] }),
    ).toThrow('unique');
    expect(() => notebookSchema.parse({ ...doc, values: { missing: 'x' } })).toThrow('Unknown parameter');
    expect(() => notebookSchema.parse({ ...doc, parameters: [{ ...parameter(), type: 'number' }] })).toThrow(
      'number',
    );
  });
  test('AI edits preserve parameters and cannot apply over changed values', () => {
    const doc = { ...newNotebook('server'), parameters: [parameter()], values: { region: 'east' } };
    const proposal = notebookProposal(
      doc,
      { summary: 'Rename', title: 'Analysis', cells: doc.cells },
      'unrestricted-sql',
    );
    expect(proposal.document.parameters).toEqual(doc.parameters);
    expect(proposal.document.values).toEqual(doc.values);
    expect(() => applyNotebookProposal({ ...doc, values: { region: 'west' } }, proposal)).toThrow('changed');
  });
});

describe('run provenance', () => {
  test('snapshots an entire batch and invalidates only referenced values', async () => {
    const options: NotebookRunOptions = {
      parameters: [parameter(), parameter('unused')],
      values: { region: 'east' },
      serviceUrl: 'server',
      sessionId: 'session',
    };
    const results: Record<string, CellResult> = {};
    const bound: unknown[][] = [];
    const runner = new NotebookRunner(
      async (_sql, _signal, context) => {
        bound.push(context.params);
        options.values!.region = 'west';
        context.phase('queued');
        context.phase('executing');
        return response();
      },
      (id, update) => {
        results[id] = { ...results[id], ...update };
      },
    );
    await runner.run([sqlCell(), { ...sqlCell(), id: 'second' }], options);
    expect(bound).toEqual([['east'], ['east']]);
    expect(results.sql.provenance).toMatchObject({
      source: 'select $region',
      sql: 'select ?',
      values: { region: 'east' },
      serviceUrl: 'server',
      sessionId: 'session',
      phase: 'complete',
      rows: 1,
    });
    expect(results.second.provenance?.number).toBe(2);
    expect(isStale(sqlCell(), results.sql, options)).toBe(true);
    expect(
      isStale(sqlCell(), results.sql, { ...options, values: { region: 'east', unused: 'changed' } }),
    ).toBe(false);
  });
  test('failure and cancellation retain the displayed result provenance', async () => {
    let result: CellResult = {};
    let fail = false;
    let cancel = false;
    const runner = new NotebookRunner(
      async () => {
        if (cancel) runner.stop();
        return fail ? { ok: false, error: 'missing table' } : response();
      },
      (_id, update) => {
        result = { ...result, ...update };
      },
    );
    const scope = { parameters: [parameter()] };
    await runner.run([sqlCell()], scope);
    const original = result.provenance;
    const table = result.table;
    fail = true;
    await runner.run([sqlCell('select $region from missing')], scope);
    expect(result.table).toBe(table);
    expect(result.provenance).toBe(original);
    expect(result.attempt).toMatchObject({
      source: 'select $region from missing',
      phase: 'failed',
      error: 'missing table',
    });
    expect(result.history).toHaveLength(2);
    fail = false;
    cancel = true;
    await runner.run([sqlCell()], scope);
    expect(result.table).toBe(table);
    expect(result.provenance).toBe(original);
    expect(result.attempt?.phase).toBe('cancelled');
    expect(result.history).toHaveLength(3);
    expect(isStale(sqlCell(), result, scope)).toBe(true);
  });
  test('explain has its own output and metadata, and does not replace query results', async () => {
    let result: CellResult = {};
    const runner = new NotebookRunner(
      async (_sql, _signal, context) => {
        expect(context.mode).toBe(result.table ? 'explain' : 'query');
        return response();
      },
      (_id, update) => {
        result = { ...result, ...update };
      },
    );
    await runner.run([sqlCell('select 42')]);
    const table = result.table,
      provenance = result.provenance;
    await runner.run([sqlCell('select 42')], { mode: 'explain' });
    expect(result.table).toBe(table);
    expect(result.provenance).toBe(provenance);
    expect(result.plan).toBeDefined();
    expect(result.planProvenance).toMatchObject({ sql: 'EXPLAIN select 42', mode: 'explain' });
    expect(isStale(sqlCell('select 42'), result)).toBe(false);
  });
});
