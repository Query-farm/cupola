import { describe, expect, test } from 'bun:test';
import { chartFilterValue, createStarter, datePreset, draftHistory, readRecoveredDrafts, reportFreshness, storeRecoveredDraft, type DraftHistory } from '../../src/lib/reports/workflow';
import { buildSnapshotHtml } from '../../src/lib/reports/snapshot';
import { createEmptyReport } from '../../src/lib/reports/types';
import { validateReport } from '../../src/lib/reports/validation';

describe('report workflow', () => {
  test('undo and redo preserve edits, reset on report changes, and invalidate redo after a new edit', () => {
    const original = createStarter('executive');
    let state: DraftHistory = { present: original, past: [], future: [] };
    const edited = { ...original, blocks: original.blocks.slice(0, -1) };
    state = draftHistory(state, { type: 'set', value: edited });
    state = draftHistory(state, { type: 'undo' });
    expect(state.present).toEqual(original);
    state = draftHistory(state, { type: 'redo' });
    expect(state.present).toEqual(edited);
    state = draftHistory(state, { type: 'set', value: { ...edited, revision: 2, updatedAt: 100 } });
    expect(state.past).toHaveLength(1);
    state = draftHistory(state, { type: 'undo' });
    state = draftHistory(state, { type: 'set', value: current => ({ ...current!, title: 'New direction' }) });
    expect(state.future).toHaveLength(0);
    state = draftHistory(state, { type: 'set', value: createEmptyReport() });
    expect(state.past).toHaveLength(0);
  });
  test('recovery is isolated by service and clearing one draft preserves others', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const a = createEmptyReport('A'); const b = createEmptyReport('B');
    storeRecoveredDraft(storage, 'service', a);
    storeRecoveredDraft(storage, 'service', b);
    expect(readRecoveredDrafts(storage, 'other')).toEqual([]);
    storeRecoveredDraft(storage, 'service', a, true);
    expect(readRecoveredDrafts(storage, 'service')).toEqual([b]);
    expect(readRecoveredDrafts({ getItem: () => '{invalid' }, 'service')).toEqual([]);
  });
  test('recovery retains empty titles without weakening saved-report validation', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const report = createStarter('executive');
    for (const title of ['', '   ']) {
      const incomplete = { ...report, title };
      storeRecoveredDraft(storage, 'service', incomplete);
      // Writing another recovery entry must not drop an incomplete draft.
      storeRecoveredDraft(storage, 'service', createEmptyReport('Other'));
      expect(readRecoveredDrafts(storage, 'service').find(draft => draft.id === report.id)).toEqual(incomplete);
      expect(validateReport(incomplete)).toContain('report.title must be a non-empty string.');
    }
    const malformed = [null, { ...report, title: null }, { ...report, title: '', blocks: null }];
    expect(readRecoveredDrafts({ getItem: () => JSON.stringify(malformed) }, 'service')).toEqual([]);
  });
  test('all starter layouts validate with runnable example datasets', () => {
    for (const id of ['executive', 'trends', 'analysis']) {
      const report = createStarter(id);
      expect(validateReport(report)).toEqual([]);
      expect(report.description).toContain('Sample data');
      expect(report.blocks.some(b => b.type === 'chart')).toBe(true);
      expect(report.blocks.some(b => b.type === 'table')).toBe(true);
    }
  });
  test('date shortcuts handle year boundaries and leap years using local calendar dates', () => {
    expect(datePreset('7', new Date(2026, 0, 3))).toEqual({ start: '2025-12-28', end: '2026-01-03' });
    expect(datePreset('previous_month', new Date(2024, 2, 5))).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(datePreset('month', new Date(2026, 8, 23))).toEqual({ start: '2026-09-01', end: '2026-09-23' });
  });
  test('freshness describes the oldest data and identifies failed or untouched datasets', () => {
    const report = createStarter('executive');
    const results = { sample: { fetchedAt: 200, runId: 2, status: 'success' }, totals: { fetchedAt: 100, runId: 2, status: 'error' } };
    expect(reportFreshness(report, results)).toMatchObject({ oldest: 100, partial: true, older: [report.datasets[1]] });
    results.totals = { fetchedAt: 205, runId: 2, status: 'success' };
    expect(reportFreshness(report, results)).toMatchObject({ oldest: 200, partial: false });
    results.totals.runId = 1;
    expect(reportFreshness(report, results).partial).toBe(true);
    expect(reportFreshness(report, {}).partial).toBe(false);
  });
  test('chart filters preserve typed choices and reject unsupported data', () => {
    expect(chartFilterValue(42, 'select')).toBe(42);
    expect(chartFilterValue('North', 'multi_select')).toEqual(['North']);
    expect(chartFilterValue('bad', 'number')).toBeUndefined();
    expect(chartFilterValue({}, 'text')).toBeUndefined();
    expect(chartFilterValue('2026-01-01', 'date_range')).toBeUndefined();
    const report = createStarter('trends');
    const chart = report.blocks.find(b => b.type === 'chart')!;
    if (chart.type !== 'chart') throw new Error('missing chart');
    chart.filter = { parameterKey: 'missing', column: 'region' };
    expect(validateReport(report).join(' ')).toContain('chart filter requires');
  });
  test('offline snapshots escape untrusted contents and exclude remote image sources', () => {
    const report = createEmptyReport('<script>alert(1)</script>');
    const html = buildSnapshotHtml(report, {}, [{ id: 'x', title: 'Title', image: 'https://example.com/tracker', columns: ['<img src=x>'], rows: [['<script>bad</script>']], totalRows: 100, fetchedAt: 1, status: 'error' }], 100);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('https://example.com');
    expect(html).toContain('1 of 100 loaded rows');
    expect(html).toContain('earlier results');
    expect(html).toContain("default-src 'none'");
  });
});
