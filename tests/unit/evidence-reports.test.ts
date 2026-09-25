import { describe, expect, test } from 'bun:test';
import { compilerParameters, deleteEvidenceReport, listEvidenceReports, resolveParameters, saveEvidenceReport, LEGACY_STORAGE_PREFIX, evidenceReportStorageKey, type EvidenceReport } from '../../src/lib/evidence/reports';
import { compileReportQuery } from '../../src/lib/reports/parameters';

function memoryStorage(): Storage {
  const records = new Map<string, string>();
  return { get length() { return records.size; }, key: i => [...records.keys()][i] ?? null, getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); }, removeItem: key => { records.delete(key); }, clear: () => records.clear() };
}
function report(): EvidenceReport {
  return { version: 1, id: 'sample', title: 'Saved test', source: '# Report', setupSql: 'SELECT $city', serviceUrl: 'https://example.com', createdAt: 1, updatedAt: 1, parameters: [{ id: 'city', key: 'city', label: 'City', type: 'text', required: true, defaultValue: 'Glen Allen' }], values: { city: 'Boston' } };
}
describe('Evidence saved reports and parameters', () => {
  test('round trips source, definitions, selected values and service without touching other storage', () => {
    const storage = memoryStorage(); storage.setItem('cupola-other', 'keep');
    const saved = saveEvidenceReport(report(), storage);
    expect(listEvidenceReports('https://example.com', storage)).toEqual([saved]);
    saveEvidenceReport({ ...saved, title: 'Renamed' }, storage);
    expect(listEvidenceReports('https://example.com', storage).map(r => r.title)).toEqual(['Renamed']);
    saveEvidenceReport({ ...saved, id: 'copy' }, storage);
    deleteEvidenceReport('https://example.com', 'sample', storage);
    expect(listEvidenceReports('https://example.com', storage).map(r => r.id)).toEqual(['copy']);
    expect(storage.getItem('cupola-other')).toBe('keep');
  });
  test('does not overwrite a report when validation or a storage write fails', () => {
    const storage = memoryStorage(); const saved = saveEvidenceReport(report(), storage);
    expect(() => saveEvidenceReport({ ...saved, parameters: [...saved.parameters, saved.parameters[0]] }, storage)).toThrow('Duplicate');
    expect(listEvidenceReports('https://example.com', storage)).toEqual([saved]);
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    expect(() => saveEvidenceReport({ ...saved, title: 'Changed' }, storage)).toThrow('Quota exceeded');
    expect(listEvidenceReports('https://example.com', storage)).toEqual([saved]);
  });
  test('reports corrupt storage without silently replacing it', () => {
    const storage = memoryStorage(); storage.setItem(evidenceReportStorageKey('https://example.com', 'bad'), '{bad');
    expect(() => listEvidenceReports('https://example.com', storage)).toThrow();
    expect(storage.getItem(evidenceReportStorageKey('https://example.com', 'bad'))).toBe('{bad');
  });
  test('checks required values, duplicate names, number types and valid dates', () => {
    const r = report(); r.values.city = '';
    expect(() => resolveParameters(r)).toThrow('required');
    r.parameters = [{ id: 'n', key: 'n', label: 'Count', type: 'number', required: true, defaultValue: 5 }]; r.values = { n: null };
    expect(() => resolveParameters(r)).toThrow('required');
    r.values = { n: '5' };
    expect(() => resolveParameters(r)).toThrow('number');
    r.parameters = [{ id: 'd', key: 'date', label: 'Date', type: 'date', required: true, defaultValue: '2026-02-30' }]; r.values = {};
    expect(() => resolveParameters(r)).toThrow('valid date');
  });
  test('keeps defaults, explicit null, false, zero and SQL-like values as bound data', () => {
    const r = report(); r.values.city = "O'Hare'); DROP TABLE data; --";
    r.parameters.push({ id: 'n', key: 'n', label: 'Count', type: 'number', required: false, defaultValue: 5 }); r.values.n = null;
    const values = resolveParameters(r);
    const compiled = compileReportQuery("SELECT $city, $n, '$city' -- $city", compilerParameters(r, values), values);
    expect(compiled.sql).toBe("SELECT ?, ?, '$city' -- $city");
    expect(compiled.params).toEqual([r.values.city, null]);
    r.values.n = 0;
    r.parameters.push({ id: 'b', key: 'b', label: 'Flag', type: 'boolean', required: true, defaultValue: true }); r.values.b = false;
    expect(resolveParameters(r)).toEqual({ city: r.values.city, n: 0, b: false });
  });
});

test('workers have independent report collections even when IDs match', () => {
  const storage = memoryStorage();
  const a = saveEvidenceReport(report(), storage);
  const b = saveEvidenceReport({ ...report(), serviceUrl: 'https://other.example/worker', title: 'Other worker' }, storage);
  saveEvidenceReport({ ...a, id: 'second', title: 'Second report' }, storage);
  expect(listEvidenceReports(a.serviceUrl, storage)).toHaveLength(2);
  expect(listEvidenceReports(b.serviceUrl, storage)).toEqual([b]);
  expect(listEvidenceReports('https://other.example/worker?tenant=two', storage)).toEqual([]);
  deleteEvidenceReport(a.serviceUrl, a.id, storage);
  expect(listEvidenceReports(a.serviceUrl, storage).map(r => r.id)).toEqual(['second']);
  expect(listEvidenceReports(b.serviceUrl, storage)).toEqual([b]);
});
test('legacy reports remain available only on their worker and migrate safely on save', () => {
  const storage = memoryStorage(); const original = report();
  storage.setItem(LEGACY_STORAGE_PREFIX + original.id, JSON.stringify(original));
  expect(listEvidenceReports(original.serviceUrl, storage)).toEqual([original]);
  expect(listEvidenceReports('https://other.example', storage)).toEqual([]);
  deleteEvidenceReport('https://other.example', original.id, storage);
  expect(storage.getItem(LEGACY_STORAGE_PREFIX + original.id)).not.toBeNull();
  const saved = saveEvidenceReport({ ...original, title: 'Upgraded' }, storage);
  expect(storage.getItem(LEGACY_STORAGE_PREFIX + original.id)).toBeNull();
  expect(listEvidenceReports(original.serviceUrl, storage)).toEqual([saved]);
});
test('failed migration preserves the old report', () => {
  const storage = memoryStorage(); const original = report();
  storage.setItem(LEGACY_STORAGE_PREFIX + original.id, JSON.stringify(original));
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  expect(() => saveEvidenceReport(original, storage)).toThrow('Quota exceeded');
  expect(listEvidenceReports(original.serviceUrl, storage)).toEqual([original]);
});

test('appearance, semantic definitions and pivot views survive storage and copying', () => {
  const storage = memoryStorage();
  const input = { ...report(), appearance: { theme: 'paper' as const, mode: 'light' as const, palette: 'accessible' as const, heading: 'serif' as const, body: 'sans-serif' as const, density: 'compact' as const, accent: '#123456' },
    semanticDatasets: [{ id: 'model', kind: 'semantic' as const, name: 'governed', query: { measures: [{ catalog_id: 'sales', entity_id: 'orders', member_id: 'revenue' }] }, acceptedModelFingerprint: 'sha256:test' }],
    pivots: [{ id: 'pivot', title: 'Explore', datasetId: 'query:governed', config: { group_by: ['country'] } }],
  };
  const saved = saveEvidenceReport(input, storage);
  saveEvidenceReport({ ...saved, id: 'copy' }, storage);
  const copy = listEvidenceReports(input.serviceUrl, storage).find(item => item.id === 'copy')!;
  expect(copy.appearance).toEqual(input.appearance);
  expect(copy.semanticDatasets).toEqual(input.semanticDatasets);
  expect(copy.pivots).toEqual(input.pivots);
  expect(() => saveEvidenceReport({ ...input, source: '```sql governed\nSELECT 1\n```' }, storage)).toThrow('conflicts');
  expect(() => saveEvidenceReport({ ...input, appearance: { ...input.appearance, accent: 'red;display:none' } }, storage)).toThrow();
});
