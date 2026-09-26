import { describe, expect, test } from 'bun:test';
import { resolveParameters, validateEvidenceReport, type EvidenceParameter, type EvidenceReport } from '../../src/lib/evidence/reports';
import { parameterDependencies, parameterDependents, parameterGraphErrors, parameterOrder } from '../../src/lib/evidence/parameter-graph';
import { formatParameterValue, optionsFromRows, reconcileValue } from '../../src/lib/evidence/parameters';
import { compileReportQuery, scanReportQuery } from '../../src/lib/reports/parameters';
import { describeInputValue, summarizeFilters } from '../../src/lib/evidence/filter-summary';
import { drillState, drillValues, matchDrillValue } from '../../src/lib/evidence/drill';
import { parameterLint } from '../../src/lib/evidence/parameter-lint';
import { parseParameterValue, serializeParameterValue, valuesFromUrl, withParameterValues } from '../../src/lib/evidence/parameter-url';

const select = (key: string, sql: string, extra: Partial<EvidenceParameter> = {}): EvidenceParameter => ({
  id: key, key, label: key[0].toUpperCase() + key.slice(1), type: 'select', required: false, defaultValue: null,
  options: { kind: 'query', sql }, ...extra,
});
function geoReport(extra: Partial<EvidenceReport> = {}): EvidenceReport {
  return {
    version: 1, id: 'geo', title: 'Geo', source: '# Geo', setupSql: '', serviceUrl: 'https://example.com', createdAt: 1, updatedAt: 1, values: {},
    parameters: [
      select('city', 'SELECT city FROM cities WHERE state = $state'),
      select('state', 'SELECT state FROM states WHERE ($country_all OR country = $country)'),
      select('country', 'SELECT country FROM countries', { allowAll: true }),
    ],
    ...extra,
  };
}

describe('parameter binding', () => {
  const parameters = [
    { id: 'r', key: 'region', label: 'Region', type: 'multi_select' as const, defaultValue: [] },
    { id: 's', key: 'state', label: 'State', type: 'select' as const, defaultValue: null },
  ];
  test('$key_all is TRUE for All / unset and FALSE otherwise, for single and multi-select', () => {
    const sql = 'SELECT 1 WHERE ($region_all OR region IN ($region)) AND ($state_all OR state = $state)';
    expect(compileReportQuery(sql, { parameters }, { region: [], state: null })).toEqual({
      sql: 'SELECT 1 WHERE (? OR region IN (NULL)) AND (? OR state = ?)', params: [true, true, null],
    });
    expect(compileReportQuery(sql, { parameters }, { region: ['East', 'West'], state: 'VA' })).toEqual({
      sql: 'SELECT 1 WHERE (? OR region IN (?, ?)) AND (? OR state = ?)', params: [false, 'East', 'West', false, 'VA'],
    });
  });
  test('a parameter actually named x_all is bound as itself', () => {
    const own = [...parameters, { id: 'a', key: 'region_all', label: 'Other', type: 'text' as const, defaultValue: 'x' }];
    expect(compileReportQuery('SELECT $region_all', { parameters: own }, { region_all: 'kept' }).params).toEqual(['kept']);
  });
  test('scanning lists references and unknown tokens without throwing', () => {
    expect(scanReportQuery("SELECT $state, $nope, '$quoted' -- $comment\n, $region_all", { parameters })).toEqual({ references: ['state', 'region'], unknown: ['nope'] });
  });
});

describe('parameter dependency graph', () => {
  test('dependencies are inferred from options queries, and ordered parents first', () => {
    const report = geoReport();
    expect(Object.fromEntries(parameterDependencies(report))).toEqual({ city: ['state'], state: ['country'], country: [] });
    expect(parameterOrder(report)).toEqual(['country', 'state', 'city']);
    expect(parameterDependents(report, 'country')).toEqual(['state', 'city']);
    expect(parameterDependents(report, 'city')).toEqual([]);
  });
  test('unknown references, self-references and cycles are errors', () => {
    expect(parameterGraphErrors(geoReport({ parameters: [select('a', 'SELECT $missing')] }))).toEqual(['A: choices query uses $missing, which is not a parameter.']);
    expect(parameterGraphErrors(geoReport({ parameters: [select('a', 'SELECT $a')] }))[0]).toContain('its own value');
    const loop = geoReport({ parameters: [select('a', 'SELECT $b'), select('b', 'SELECT $c'), select('c', 'SELECT $a')] });
    expect(parameterGraphErrors(loop)).toEqual(['Parameter choices depend on each other in a loop: $a → $b → $c → $a.']);
    expect(() => validateEvidenceReport(loop)).toThrow('loop');
  });
  test('a bare date-range reference names the right fix', () => {
    const report = geoReport({ parameters: [select('a', 'SELECT $period'), { id: 'p', key: 'period', label: 'Period', type: 'date_range', required: false, defaultValue: { start: null, end: null } }] });
    expect(parameterGraphErrors(report)).toEqual(['A: choices query must use $period_start or $period_end, not $period.']);
  });
  test('drill paths must name distinct parameters', () => {
    expect(() => validateEvidenceReport(geoReport({ drillPaths: [{ id: 'geo', levels: ['country', 'state', 'city'] }] }))).not.toThrow();
    expect(() => validateEvidenceReport(geoReport({ drillPaths: [{ id: 'geo', levels: ['country', 'county'] }] }))).toThrow('"county" is not a parameter');
    expect(() => validateEvidenceReport(geoReport({ drillPaths: [{ id: 'geo', levels: ['state', 'state'] }] }))).toThrow('repeats');
  });
});

describe('parameter values and choices', () => {
  const options = [{ value: 'VA', label: 'Virginia' }, { value: 'OR', label: 'Oregon' }];
  test('choices come from value/label columns, else the first two columns', () => {
    const parameter = select('state', 'x');
    expect(optionsFromRows(parameter, [{ label: 'Virginia', value: 'VA' }, { label: 'Dup', value: 'VA' }, { label: 'none', value: null }], ['label', 'value'])).toEqual({ options: [{ value: 'VA', label: 'Virginia' }], truncated: false });
    expect(optionsFromRows(parameter, [{ code: 'VA', name: 'Virginia' }], ['code', 'name']).options).toEqual([{ value: 'VA', label: 'Virginia' }]);
    expect(optionsFromRows(parameter, [{ n: 1n }], ['n']).options).toEqual([{ value: 1, label: '1' }]);
    expect(() => optionsFromRows(select('s', 'x', { options: { kind: 'query', sql: 'x', valueColumn: 'id' } }), [], ['code'])).toThrow('no "id" column');
  });
  test('a value that is no longer a choice resets with a note', () => {
    const parameter = select('state', 'x', { label: 'State', allowAll: true });
    const label = (v: unknown) => options.find(o => o.value === v)?.label ?? String(v);
    expect(reconcileValue(parameter, 'VA', options, label)).toEqual({ value: 'VA' });
    expect(reconcileValue(parameter, 'TX', options, label)).toEqual({ value: null, note: 'State reset to All: TX is no longer a choice.' });
    expect(reconcileValue({ ...parameter, defaultMode: 'first', allowAll: false }, 'TX', options, label)).toEqual({ value: 'VA', note: 'State reset to Virginia: TX is no longer a choice.' });
    expect(reconcileValue(parameter, 'TX', undefined)).toEqual({ value: 'TX' });
  });
  test('multi-select keeps surviving choices', () => {
    const parameter: EvidenceParameter = { ...select('states', 'x'), label: 'States', type: 'multi_select', defaultValue: [] };
    expect(reconcileValue(parameter, ['VA', 'TX'], options, v => String(v))).toEqual({ value: ['VA'], note: 'States: TX is no longer a choice.' });
    expect(reconcileValue(parameter, [], options)).toEqual({ value: [] });
  });
  test('"first" fills an unset value unless All is allowed', () => {
    const parameter = select('state', 'x', { defaultMode: 'first' });
    expect(reconcileValue(parameter, null, options)).toEqual({ value: 'VA' });
    expect(reconcileValue({ ...parameter, allowAll: true }, null, options)).toEqual({ value: null });
  });
  test('values read as labels, All, lists and ranges', () => {
    const parameter = select('state', 'x', { allowAll: true });
    expect(formatParameterValue(parameter, 'OR', options)).toBe('Oregon');
    expect(formatParameterValue(parameter, null, options)).toBe('All');
    expect(formatParameterValue({ ...parameter, type: 'multi_select' }, ['VA', 'OR'], options)).toBe('Virginia, Oregon');
    const range: EvidenceParameter = { id: 'p', key: 'p', label: 'P', type: 'date_range', required: false, defaultValue: { start: null, end: null } };
    expect(formatParameterValue(range, { start: '2024-01-01', end: '2024-03-31' })).toBe('2024-01-01 – 2024-03-31');
    expect(formatParameterValue(range, { start: null, end: null })).toBe('Any dates');
  });
  test('required select with All allowed accepts All; date ranges validate order', () => {
    expect(resolveParameters(geoReport({ parameters: [select('country', 'SELECT 1', { required: true, allowAll: true })] }))).toEqual({ country: null });
    expect(() => resolveParameters(geoReport({ parameters: [select('country', 'SELECT 1', { required: true })] }))).toThrow('Country is required.');
    const range: EvidenceParameter = { id: 'p', key: 'p', label: 'Period', type: 'date_range', required: false, defaultValue: { start: '2024-05-01', end: '2024-01-01' } };
    expect(() => validateEvidenceReport(geoReport({ parameters: [range] }))).toThrow('start on or before its end');
  });
  test('saved reports without the new fields still load', () => {
    const legacy = { version: 1, id: 'old', title: 'Old', source: '', setupSql: 'SELECT $city', serviceUrl: 's', createdAt: 1, updatedAt: 1, values: { city: 'Boston' }, parameters: [{ id: 'c', key: 'city', label: 'City', type: 'text', required: true, defaultValue: 'Glen Allen' }] };
    expect(resolveParameters(validateEvidenceReport(legacy))).toEqual({ city: 'Boston' });
  });
});

describe('parameter values in the URL', () => {
  const make = (type: EvidenceParameter['type'], defaultValue: EvidenceParameter['defaultValue'] = null): EvidenceParameter => ({ id: type, key: type, label: type, type, required: false, defaultValue });
  test('each type round-trips through its readable form', () => {
    const cases: [EvidenceParameter, EvidenceParameter['defaultValue'], string][] = [
      [make('text', ''), 'a & b', 'a & b'],
      [make('number', 0), 2.5, '2.5'],
      [make('boolean', false), true, 'true'],
      [make('date', ''), '2024-02-29', '2024-02-29'],
      [make('select'), 'VA', 'VA'],
      [make('multi_select', []), ['VA', 7], '["VA",7]'],
      [make('date_range', { start: null, end: null }), { start: '2024-01-01', end: null }, '2024-01-01..'],
    ];
    for (const [parameter, value, text] of cases) {
      expect(serializeParameterValue(parameter, value)).toBe(text);
      expect(parseParameterValue(parameter, text)).toEqual(value);
    }
    expect(parseParameterValue(make('select'), '')).toBeNull();
    expect(parseParameterValue(make('number'), 'abc')).toBeUndefined();
    expect(parseParameterValue(make('date_range'), 'nonsense')).toBeUndefined();
  });
  test('only values that differ from the initial value are written; stale p. params go', () => {
    const parameters = [make('select', 'VA'), make('text', '')];
    const url = withParameterValues(new URL('https://x/r?service=s&p.old=1&p.select=OR&category=Books'), parameters, { select: 'VA', text: 'hi' });
    expect(url.search).toBe('?service=s&category=Books&p.text=hi');
    // Choosing All when the default is a value must survive the round trip as an explicit empty.
    const all = withParameterValues(new URL('https://x/r'), parameters, { select: null, text: '' });
    expect(all.search).toBe('?p.select=');
    expect(valuesFromUrl(parameters, all.searchParams)).toEqual({ select: null });
  });
});

describe('the PDF filter summary', () => {
  test('parameters by label, inputs by title, the drill path first', () => {
    const parameters: EvidenceParameter[] = [
      select('state', 'x', { label: 'State', allowAll: true }),
      { id: 'p', key: 'period', label: 'Period', type: 'date_range', required: false, defaultValue: { start: null, end: null } },
    ];
    const summary = summarizeFilters({
      parameters, values: { state: 'VA', period: { start: '2025-01-01', end: '2025-06-30' } },
      states: { state: { status: 'ready', truncated: false, options: [{ value: 'VA', label: 'Virginia' }] } },
      inputs: [
        { id: 'state', component: 'html', value: 'VA' }, // the parameter's own bridge filter: listed once
        { id: 'category_filter', component: 'dropdown', value: 'Books', title: 'Category' },
        { id: 'min_orders', component: 'slider', value: 50 },
        { id: 'unset', component: 'dropdown', value: undefined },
      ],
      drill: 'All countries › United States › Virginia',
    });
    expect(summary.filters).toEqual([
      { label: 'Drill path', value: 'All countries › United States › Virginia' },
      { label: 'State', value: 'Virginia' },
      { label: 'Period', value: '2025-01-01 – 2025-06-30' },
      { label: 'Category', value: 'Books' },
      { label: 'Min orders', value: '50' },
      { label: 'Unset', value: 'All' },
    ]);
    expect(summary.appendix).toEqual([]);
  });
  test('a long list is summarized in the header and listed in full in the appendix', () => {
    const values = Array.from({ length: 12 }, (_, i) => `City ${i + 1}`);
    const summary = summarizeFilters({ parameters: [], values: {}, inputs: [{ id: 'cities', component: 'dropdown', value: values }] });
    expect(summary.filters).toEqual([{ label: 'Cities', value: '12 selected: City 1, City 2, City 3, … (all listed under Filter values)' }]);
    expect(summary.appendix).toEqual([{ label: 'Cities', values }]);
  });
  test('input values in their several shapes', () => {
    expect(describeInputValue(new Date(2025, 2, 4))).toBe('2025-03-04');
    expect(describeInputValue({ start: '2025-01-01', end: null })).toBe('From 2025-01-01');
    expect(describeInputValue({ region: ['East', 'West'], channel: [] })).toBe('Region: East, West');
    expect(describeInputValue(false)).toBe('No');
    expect(describeInputValue([])).toBe('All');
  });
});

describe('drill paths', () => {
  const path = { id: 'geo', label: 'All places', levels: ['country', 'state', 'city'] };
  const parameters = geoReport().parameters;
  const states = {
    country: { status: 'ready' as const, truncated: false, options: [{ value: 'US', label: 'United States' }, { value: 'CA', label: 'Canada' }] },
    state: { status: 'ready' as const, truncated: false, options: [{ value: 'VA', label: 'Virginia' }] },
  };
  test('the breadcrumb follows the levels set from the top, and names the next level', () => {
    expect(drillState(path, parameters, { country: null, state: null, city: null }, states)).toMatchObject({ crumbs: [{ label: 'All places', depth: 0 }], next: { key: 'country' } });
    const deep = drillState(path, parameters, { country: 'US', state: 'VA', city: null }, states);
    expect(deep.crumbs.map(crumb => crumb.label)).toEqual(['All places', 'United States', 'Virginia']);
    expect(deep.next?.key).toBe('city');
    expect(drillState(path, parameters, { country: 'US', state: 'VA', city: 'Richmond' }, states).next).toBeNull();
    // A lower level set without its parent is not part of the path yet.
    expect(drillState(path, parameters, { country: null, state: 'VA', city: null }, states).crumbs).toHaveLength(1);
  });
  test('clicked text matches a choice by label, then value', () => {
    expect(matchDrillValue(parameters.find(p => p.key === 'country')!, ' United States ', states)).toBe('US');
    expect(matchDrillValue(parameters.find(p => p.key === 'country')!, 'CA', states)).toBe('CA');
    expect(matchDrillValue(parameters.find(p => p.key === 'country')!, 'Mexico', states)).toBeUndefined();
    expect(matchDrillValue({ ...parameters[0], type: 'multi_select' }, 'Canada', { city: states.country })).toEqual(['CA']);
  });
  test('drilling sets one level and clears those below; stepping up clears from a depth', () => {
    const values = { country: 'US', state: 'VA', city: 'Richmond', other: 'kept' };
    expect(drillValues(path, parameters, { country: 'US', state: null, city: 'stale' }, 1, 'VA')).toEqual({ country: 'US', state: 'VA', city: null });
    expect(drillValues(path, parameters, values, 1)).toEqual({ country: 'US', state: null, city: null, other: 'kept' });
    expect(drillValues(path, parameters, values, 0)).toEqual({ country: null, state: null, city: null, other: 'kept' });
  });
});

describe('parameter lint', () => {
  test('flags unknown references, unused parameters, input name clashes and unmatchable drill levels', () => {
    const report = geoReport({
      setupSql: 'SELECT $country, $nope',
      source: '# R\n\n```sql q\nSELECT $state, $period\n```\n\n{% dropdown id="city" data="q" value_column="state" /%}\n',
      parameters: [
        ...geoReport().parameters,
        { id: 'p', key: 'period', label: 'Period', type: 'date_range', required: false, defaultValue: { start: null, end: null } },
        { id: 'n', key: 'limit', label: 'Row limit', type: 'number', required: false, defaultValue: 10 },
      ],
      drillPaths: [{ id: 'd', label: 'All', levels: ['country', 'limit'] }],
    });
    const messages = parameterLint(report).map(issue => `${issue.severity}: ${issue.message}${issue.line ? ` @${issue.line}` : ''}`);
    expect(messages).toEqual([
      'error: Setup SQL uses $nope, which is not a parameter.',
      'error: Query "q" uses $period; a date range is $period_start or $period_end. @3',
      'warning: Drill path All: Row limit has no choices, so a click can\'t be matched to a value. Make it a select.',
      'error: Parameter "city" has the same name as an Evidence input in the document; rename one of them.',
    ]);
  });
  test('a report using every parameter is clean', () => {
    const report = geoReport({ source: '# R\n\n```sql q\nSELECT * FROM t WHERE ($city_all OR city = $city)\n```\n' });
    expect(parameterLint(report)).toEqual([]);
  });
});
