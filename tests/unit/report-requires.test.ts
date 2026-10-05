import { describe, expect, test } from 'bun:test';
import { deriveRequires, findReportAliasReferences, reportSqlParts, resolveRequires, rewriteReportAliases, sqlFenceRanges, withDerivedRequires, type RequireCatalog } from '../../src/lib/evidence/report-requires';
import { sourceQueries } from '../../src/lib/evidence/source-queries';
import { validateEvidenceReport, type EvidenceReport } from '../../src/lib/evidence/reports';
import { parseReportFile, planImport, serializeReportFile, REPORT_FILE_VERSION } from '../../src/lib/evidence/report-file';

const SOURCE = [
  '# Sales from sales.main.orders',
  '',
  'Prose naming sales.main.orders is not SQL.',
  '',
  '```sql by_region',
  "SELECT region, sum(amount) AS total FROM sales.main.orders WHERE note <> 'sales.main.x' GROUP BY region",
  '```',
  '',
  '{% bar_chart data="by_region" x="region" y="total" title="sales.main.orders" /%}',
  '',
  '````markdown',
  '```sql not_a_query',
  'SELECT * FROM sales.main.hidden',
  '```',
  '````',
  '',
  '~~~sql other',
  'SELECT * FROM "sales".main.items JOIN crm.main.accounts ON true',
  '~~~',
].join('\n');

const report = (overrides: Partial<EvidenceReport> = {}): EvidenceReport => ({
  version: 1, id: 'r1', title: 'Sales', source: SOURCE, setupSql: 'CREATE OR REPLACE TEMP TABLE t AS SELECT * FROM sales.main.orders',
  serviceUrl: 'https://a.example', workspaceId: 'ws1', createdAt: 1, updatedAt: 2, values: {},
  parameters: [{ id: 'p1', key: 'region', label: 'Region', type: 'select', required: false, defaultValue: null, options: { kind: 'query', sql: 'SELECT DISTINCT region FROM sales.main.orders' } }],
  ...overrides,
});

const SALES: RequireCatalog = { alias: 'sales', url: 'https://a.example', catalogName: 'sales' };
const CRM: RequireCatalog = { alias: 'crm', url: 'https://crm.example/', catalogName: 'crm' };

describe('sqlFenceRanges', () => {
  test('finds the ```sql and ~~~sql fences Markdoc does, not one inside another fence', () => {
    const fences = sqlFenceRanges(SOURCE).map(range => SOURCE.slice(range.start, range.end).trim());
    expect(fences).toEqual(sourceQueries(SOURCE).map(query => query.sql.trim()));
    expect(fences).toHaveLength(2);
  });
  test('an unclosed fence runs to the end', () => {
    const source = '```sql q\nSELECT 1 FROM sales.main.t';
    expect(sqlFenceRanges(source).map(r => source.slice(r.start, r.end))).toEqual(['SELECT 1 FROM sales.main.t']);
  });
  test('only sql fences', () => {
    expect(sqlFenceRanges('```python\nsales.main.t\n```\n')).toEqual([]);
  });
});

describe('report alias references', () => {
  test('in fences, setup SQL and choices queries only', () => {
    const parts = reportSqlParts(report());
    expect(parts.map(part => part.where)).toEqual(['source', 'source', 'setupSql', 'parameter']);
    const refs = findReportAliasReferences(report(), 'sales');
    expect(refs.map(ref => ref.where)).toEqual(['source', 'source', 'setupSql', 'parameter']);
    // Line and column in the whole source.
    expect(refs[0]).toMatchObject({ line: 6, column: 42, text: 'sales' });
    expect(refs[1]).toMatchObject({ line: 18, text: '"sales"' });
    expect(refs[3]).toMatchObject({ label: 'Region' });
  });
  test('rewrite leaves prose, tags and other fences alone, and renames requires', () => {
    const { report: next, count } = rewriteReportAliases({ ...report(), requires: [SALES, CRM] }, { sales: 'sales_eu' });
    expect(count).toBe(4);
    expect(next.source).toContain('Prose naming sales.main.orders is not SQL.');
    expect(next.source).toContain('title="sales.main.orders"');
    expect(next.source).toContain('SELECT * FROM sales.main.hidden');
    expect(next.source).toContain("FROM sales_eu.main.orders WHERE note <> 'sales.main.x'");
    expect(next.source).toContain('FROM "sales_eu".main.items');
    expect(next.setupSql).toBe('CREATE OR REPLACE TEMP TABLE t AS SELECT * FROM sales_eu.main.orders');
    expect(next.parameters[0].options).toEqual({ kind: 'query', sql: 'SELECT DISTINCT region FROM sales_eu.main.orders' });
    expect(next.requires).toEqual([{ ...SALES, alias: 'sales_eu' }, CRM]);
  });
  test('nothing to rewrite: the same report', () => {
    const original = report();
    expect(rewriteReportAliases(original, { nope: 'x' })).toEqual({ report: original, count: 0 });
  });
});

describe('deriveRequires', () => {
  test('the workspace catalogs the SQL references, in workspace order', () => {
    expect(deriveRequires(report(), [CRM, SALES, { alias: 'unused', url: 'https://u', catalogName: 'u' }])).toEqual([CRM, SALES]);
  });
  test('unqualified SQL requires nothing', () => {
    expect(deriveRequires(report({ source: '```sql q\nSELECT * FROM orders\n```', setupSql: '', parameters: [] }), [SALES])).toBeUndefined();
  });
  test('keeps an earlier requirement the workspace lacks while the SQL still names it', () => {
    const earlier = { alias: 'warehouse', url: 'https://w', catalogName: 'wh' };
    const withWarehouse = report({ setupSql: 'SELECT * FROM warehouse.main.t', requires: [earlier] });
    expect(deriveRequires(withWarehouse, [SALES])).toEqual([SALES, earlier]);
    // Once the SQL stops naming it, it goes.
    expect(deriveRequires(report({ requires: [earlier] }), [SALES])).toEqual([SALES]);
  });
  test('the workspace catalog wins over an earlier requirement with its alias', () => {
    const stale = { alias: 'sales', url: 'https://old', catalogName: 'sales' };
    expect(deriveRequires(report({ requires: [stale] }), [SALES])).toEqual([SALES]);
  });
  test('withDerivedRequires returns the same object when nothing changes', () => {
    const r = report({ requires: [SALES] });
    expect(withDerivedRequires(r, [SALES])).toBe(r);
    expect(withDerivedRequires(report(), [SALES]).requires).toEqual([SALES]);
    expect('requires' in withDerivedRequires(report({ source: '', setupSql: '', parameters: [], requires: [SALES] }), [SALES])).toBe(false);
  });
});

describe('resolveRequires', () => {
  test('nothing required, or everything here: ok', () => {
    expect(resolveRequires(undefined, [])).toEqual({ ok: true, rebind: [], missing: [] });
    expect(resolveRequires([SALES, CRM], [SALES, { ...CRM, url: 'https://CRM.example' }]).ok).toBe(true);
  });
  test('the same catalog under another alias: rebind', () => {
    const here = [{ ...SALES, alias: 'sales_eu' }];
    expect(resolveRequires([SALES], here)).toEqual({ ok: false, rebind: [{ from: 'sales', to: 'sales_eu', requirement: SALES }], missing: [] });
  });
  test('rebind is preferred over a different catalog that has the alias', () => {
    const here = [{ alias: 'sales', url: 'https://b.example', catalogName: 'sales' }, { ...SALES, alias: 'sales_a' }];
    expect(resolveRequires([SALES], here).rebind.map(r => [r.from, r.to])).toEqual([['sales', 'sales_a']]);
  });
  test('a different catalog with the same alias meets it (e.g. staging)', () => {
    expect(resolveRequires([SALES], [{ alias: 'sales', url: 'https://staging.example', catalogName: 'sales' }]).ok).toBe(true);
  });
  test('missing when neither the catalog nor its alias is here', () => {
    expect(resolveRequires([SALES, CRM], [SALES])).toEqual({ ok: false, rebind: [], missing: [CRM] });
  });
  test('swapped aliases rebind both ways', () => {
    const a = { alias: 'a', url: 'https://a', catalogName: 'a' };
    const b = { alias: 'b', url: 'https://b', catalogName: 'b' };
    expect(resolveRequires([a, b], [{ ...a, alias: 'b' }, { ...b, alias: 'a' }]).rebind.map(r => [r.from, r.to])).toEqual([['a', 'b'], ['b', 'a']]);
  });
});

describe('report files carry requires', () => {
  const withRequires = report({ requires: [SALES, CRM] });
  test('round trip without a format version bump', () => {
    const text = serializeReportFile([{ report: withRequires }]);
    expect(JSON.parse(text).version).toBe(REPORT_FILE_VERSION);
    expect(REPORT_FILE_VERSION).toBe(2);
    expect(parseReportFile(text).reports[0].requires).toEqual([SALES, CRM]);
  });
  test('version 1 and 2 files without it still import', () => {
    for (const version of [1, 2]) {
      const parsed = parseReportFile(JSON.stringify({ format: 'cupola-evidence-reports', version, reports: [report()] }));
      expect(parsed.errors).toEqual([]);
      expect(parsed.reports[0].requires).toBeUndefined();
      expect('requires' in parsed.reports[0]).toBe(false);
    }
  });
  test('a malformed requires is dropped, not fatal', () => {
    const parsed = parseReportFile(JSON.stringify([{ ...report(), requires: [{ alias: 5 }] }]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.reports[0].requires).toBeUndefined();
    expect(validateEvidenceReport({ ...report(), requires: 'nope' }).requires).toBeUndefined();
  });
  test('import keeps the file\'s requires, and a report differing only in requires is unchanged', () => {
    const [planned] = planImport([withRequires], [], { serviceUrl: 'https://x', workspaceId: 'ws2' }, () => true);
    expect(planned.report.requires).toEqual([SALES, CRM]);
    const [same] = planImport([withRequires], [report({ requires: [SALES] })], 'https://x', () => true);
    expect(same.action).toBe('unchanged');
  });
});
