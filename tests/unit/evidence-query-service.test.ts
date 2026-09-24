import { afterEach, describe, expect, test } from 'bun:test';
import { Decimal, Table, Vector, makeData, tableFromArrays, tableToIPC, vectorFromArray, List, Field, Float64 } from '@query-farm/apache-arrow';
import { evidenceResult, HaybarnQueryService } from '../../src/lib/evidence/haybarn-query-service';
import { engine } from '../../src/lib/shell-bridge';

const originalQuery = engine.query;
const originalPrepared = engine.queryPrepared;
afterEach(() => { engine.query = originalQuery; engine.queryPrepared = originalPrepared; });

describe('Evidence Haybarn adapter', () => {
  test('keeps large integers, nulls, dates and decimal scale intact', () => {
    const table = tableFromArrays({ amount: [9007199254740993n], missing: [null], time: [new Date('2026-09-23T12:00:00Z')] });
    const result = evidenceResult(table);
    expect(result.rows[0].amount).toBe('9007199254740993');
    expect(result.rows[0].missing).toBeNull();
    expect(result.rows[0].time).toBe('2026-09-23T12:00:00.000');
    const decimal = new Vector([makeData({ type: new Decimal(2, 18), length: 1, data: new Uint32Array([2188275, 0, 0, 0]) })]);
    expect(evidenceResult(new Table({ amount: decimal })).rows[0].amount).toBe('21882.75');
  });
  test('runs through the existing engine and coalesces repeated SQL', async () => {
    let calls = 0;
    const bytes = tableToIPC(tableFromArrays({ temperature: [72.5] }));
    engine.query = async () => { calls++; return { ok: true, arrowBuffers: [bytes.slice().buffer] }; };
    const service = new HaybarnQueryService();
    const [a, b] = await Promise.all([service.query('select temperature'), service.query('select temperature')]);
    expect(calls).toBe(1);
    expect(a.rows).toEqual([{ temperature: 72.5 }]);
    expect(b.rows).toEqual(a.rows);
    await service.query('select temperature', { noCache: true });
    expect(calls).toBe(2);
  });
  test('surfaces engine errors and allows a retry', async () => {
    engine.query = async () => ({ ok: false, error: 'Worker unavailable' });
    const service = new HaybarnQueryService();
    expect((await service.query('select 1')).error).toBe('Worker unavailable');
    engine.query = async () => ({ ok: true });
    expect((await service.query('select 1')).error).toBeNull();
  });
  test('does not execute an already cancelled query', async () => {
    let calls = 0;
    engine.query = async () => { calls++; return { ok: true }; };
    const signal = AbortSignal.abort();
    await expect(new HaybarnQueryService().query('select 1', { signal })).rejects.toThrow('Query cancelled');
    expect(calls).toBe(0);
  });
});

test('Evidence SQL binds parameters without interpolating user text', async () => {
  let actualSql = '', actualParams: unknown[] = [];
  engine.query = async () => ({ ok: true });
  engine.queryPrepared = async (sql, params) => { actualSql = sql; actualParams = params; return { ok: true }; };
  const city = "O'Hare'); DROP TABLE report; --";
  const service = new HaybarnQueryService(undefined, [{ id: 'city', key: 'city', label: 'City', type: 'text', defaultValue: 'default' }], { city });
  expect((await service.query("SELECT $city AS city, '$city' AS literal")).error).toBeNull();
  expect(actualSql).toBe("SELECT ? AS city, '$city' AS literal");
  expect(actualParams).toEqual([city]);
  expect((await service.query('SELECT $unknown')).error).toContain('Unknown report parameter');
});

test('turns nested Arrow lists into arrays for Evidence sparklines', () => {
  const type = new List(new Field('item', new List(new Field('item', new Float64()))));
  const sparkline = vectorFromArray([[[1, 72.5], [2, 73]], null], type);
  expect(evidenceResult(new Table({ sparkline })).rows as unknown).toEqual([
    { sparkline: [[1, 72.5], [2, 73]] }, { sparkline: null },
  ]);
});

test('normalizes DuckDB JSON sparkline tuples using the Evidence row contract', () => {
  const table = tableFromArrays({ __ev_sparkline_high: ['[["2026-09-23 23:00:00",72.5]]'], ordinary_json: ['[1,2]'] });
  expect(evidenceResult(table).rows as unknown).toEqual([{ __ev_sparkline_high: [['2026-09-23 23:00:00', 72.5]], ordinary_json: '[1,2]' }]);
});

test('report scope applies the 60-second limit to prepared, regular and Arrow queries', async () => {
  const { EvidenceQueryRun, REPORT_QUERY_TIMEOUT_MS } = await import('../../src/lib/evidence/query-run');
  const calls: any[] = [];
  const bytes = tableToIPC(tableFromArrays({ value: [1] }));
  engine.query = async (_sql, opts) => { calls.push(opts); return { ok: true, arrowBuffers: [bytes.slice().buffer] }; };
  engine.queryPrepared = async (_sql, _params, opts) => { calls.push(opts); return { ok: true }; };
  const activity: number[] = [];
  const run = new EvidenceQueryRun(count => activity.push(count));
  const service = new HaybarnQueryService(undefined, [], {}, run);
  await run.query('select ?', [1]);
  await service.query('select 1');
  await service.queryArrow('select 2');
  expect(calls).toHaveLength(3);
  expect(calls.every(call => call.timeoutMs === 60_000 && call.signal === run.signal)).toBe(true);
  expect(REPORT_QUERY_TIMEOUT_MS).toBe(60_000);
  expect(activity).toEqual([1, 0, 1, 0, 1, 0]);
  run.stop();
  await expect(service.query('select 1')).rejects.toThrow('Report refresh stopped');
  await expect(service.queryArrow('select 2')).rejects.toThrow('Report refresh stopped');
  expect(calls).toHaveLength(3);
});

test('stopping a report cancels readiness without waiting for the engine', async () => {
  const { EvidenceQueryRun } = await import('../../src/lib/evidence/query-run');
  const run = new EvidenceQueryRun();
  const pending = run.wait(new Promise(() => {}));
  run.stop();
  await expect(pending).rejects.toThrow('Report refresh stopped');
});

test('stopping a run interrupts its active query, skips queued SQL and allows a new run', async () => {
  const { EvidenceQueryRun } = await import('../../src/lib/evidence/query-run');
  const { createQueryExecutor } = await import('../../src/lib/query-execution');
  let release!: (result: { ok: boolean }) => void;
  let interrupts = 0;
  const calls: string[] = [];
  const execute = createQueryExecutor(() => { interrupts++; release({ ok: false }); });
  engine.query = (sql, opts) => execute(() => {
    calls.push(sql);
    return sql === 'slow' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true });
  }, opts);
  const run = new EvidenceQueryRun();
  const service = new HaybarnQueryService(undefined, [], {}, run);
  const first = service.query('slow');
  const second = service.query('queued');
  await Promise.resolve();
  run.stop();
  expect((await first).error).toBe('Report refresh stopped.');
  expect((await second).error).toBe('Report refresh stopped.');
  expect(interrupts).toBe(1);
  expect(calls).toEqual(['slow']);
  expect((await new HaybarnQueryService().query('recovered')).error).toBeNull();
});
