import { describe, expect, test } from 'bun:test';
import { parseReportFile, planImport, reportFileName, serializeReportFile, REPORT_FILE_FORMAT } from '../../src/lib/evidence/report-file';
import type { EvidenceReport } from '../../src/lib/evidence/reports';
import { emptyHistory, recordRevision } from '../../src/lib/evidence/revisions';

const report = (overrides: Partial<EvidenceReport> = {}): EvidenceReport => ({
  version: 1, id: 'r1', title: 'Sales by place', source: '# Sales\n\n```sql q\nSELECT $country AS c\n```', setupSql: 'CREATE OR REPLACE TEMP TABLE t AS SELECT 1',
  serviceUrl: 'https://a.example', createdAt: 1, updatedAt: 2, values: { country: 'US' },
  parameters: [{ id: 'p1', key: 'country', label: 'Country', type: 'select', required: false, defaultValue: null, allowAll: true, options: { kind: 'static', values: [{ label: 'United States', value: 'US' }] } }],
  drillPaths: [{ id: 'd1', levels: ['country'] }],
  ...overrides,
});

describe('report files', () => {
  test('round-trip every part of the specification', () => {
    const text = serializeReportFile([{ report: report() }], new Date('2026-09-28T00:00:00Z'));
    expect(JSON.parse(text)).toMatchObject({ format: REPORT_FILE_FORMAT, version: 2, exportedAt: '2026-09-28T00:00:00.000Z' });
    expect(parseReportFile(text)).toEqual({ reports: [report()], histories: [emptyHistory()], errors: [] });
  });
  test('accept a bare report or an array of them', () => {
    expect(parseReportFile(JSON.stringify(report())).reports).toEqual([report()]);
    expect(parseReportFile(JSON.stringify([report(), report({ id: 'r2' })])).reports).toHaveLength(2);
  });
  test('keep the valid reports and name the invalid ones', () => {
    const parsed = parseReportFile(serializeReportFile([{ report: report() }, { report: { ...report({ id: 'r2', title: 'Broken' }), parameters: 'nope' } as unknown as EvidenceReport }]));
    expect(parsed.reports.map(item => item.id)).toEqual(['r1']);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toStartWith('“Broken”: parameters');
  });
  test('carry each report\'s history, and import a report whose history is damaged without it', () => {
    const history = recordRevision(recordRevision(emptyHistory(), report({ title: 'Old' }), { kind: 'edit', savedAt: 1 }), report(), { kind: 'agent', agentSummaries: ['Rename'], savedAt: 2 });
    const parsed = parseReportFile(serializeReportFile([{ report: report(), history }]));
    expect(parsed.histories[0]).toEqual(history);
    const damaged = JSON.parse(serializeReportFile([{ report: report(), history }]));
    damaged.reports[0].history.blobs = {};
    const partial = parseReportFile(JSON.stringify(damaged));
    expect(partial.reports).toHaveLength(1);
    expect(partial.histories[0]).toEqual(emptyHistory());
    expect(partial.errors[0]).toContain('imported without its revision history');
  });
  test('version 1 files still import', () => {
    expect(parseReportFile(JSON.stringify({ format: REPORT_FILE_FORMAT, version: 1, reports: [report()] })).reports).toEqual([report()]);
  });
  test('refuse what is not a report file', () => {
    expect(() => parseReportFile('not json')).toThrow('not valid JSON');
    expect(() => parseReportFile('{"hello": 1}')).toThrow('not a Cupola report file');
    expect(() => parseReportFile(JSON.stringify({ format: REPORT_FILE_FORMAT, version: 99, reports: [] }))).toThrow('newer version');
  });
  test('file names', () => {
    expect(reportFileName([{ title: 'Sales by Place!' }])).toBe('sales-by-place.cupola-reports.json');
    expect(reportFileName([{ title: 'a' }, { title: 'b' }])).toBe('cupola-reports.cupola-reports.json');
  });
});

describe('planImport', () => {
  const never = () => { throw new Error('should not ask'); };
  test('imports into the current service', () => {
    const [plan] = planImport([report()], [], 'https://b.example', never);
    expect(plan.action).toBe('new');
    expect(plan.report.serviceUrl).toBe('https://b.example');
  });
  test('skips a report already saved as it is, whenever and wherever it was saved', () => {
    const [plan] = planImport([report({ updatedAt: 99, serviceUrl: 'https://a.example' })], [report({ serviceUrl: 'https://b.example' })], 'https://b.example', never);
    expect(plan.action).toBe('unchanged');
  });
  test('replaces a changed report, or keeps both', () => {
    const saved = report({ serviceUrl: 'https://b.example', createdAt: 5 });
    const changed = report({ source: '# Changed' });
    const [replaced] = planImport([changed], [saved], 'https://b.example', () => true);
    expect(replaced).toMatchObject({ action: 'replace', report: { id: 'r1', createdAt: 5, source: '# Changed' } });
    const [copied] = planImport([changed], [saved], 'https://b.example', () => false, () => 'new-id');
    expect(copied).toMatchObject({ action: 'copy', report: { id: 'new-id', title: 'Sales by place (imported)', source: '# Changed' } });
  });
  test('the same report twice in one file is imported once', () => {
    const plans = planImport([report(), report()], [], 'https://b.example', never);
    expect(plans.map(plan => plan.action)).toEqual(['new', 'unchanged']);
  });
});
