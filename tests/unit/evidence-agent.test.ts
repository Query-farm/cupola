import { describe, expect, test } from 'bun:test';
import { createReportProposal, applyReportProposal, EVIDENCE_AGENT_TOOLS, EVIDENCE_AGENT_PROMPT } from '../../src/lib/evidence/agent';
import { introducedIssues, unclosedTagIssues } from '../../src/lib/evidence/source-check';
import { toolsForAIQueryMode } from '../../src/lib/ai/query-mode';
import type { EvidenceReport } from '../../src/lib/evidence/reports';
const report: EvidenceReport = { version: 1, id: 'one', title: 'Original', source: '# Original', setupSql: 'SELECT 1', serviceUrl: 'https://example.com', parameters: [], values: {}, createdAt: 1, updatedAt: 1 };
test('proposal stages changes, preserves identity and allows saving while review is open', () => {
  const proposal = createReportProposal(report, { summary: 'Rename', changes: { title: 'Revised' } });
  expect(report.title).toBe('Original');
  expect(proposal.fields).toEqual(['title']);
  expect(applyReportProposal({ ...report, updatedAt: 100 }, proposal)).toEqual({ ...report, title: 'Revised', updatedAt: 100 });
});
test('manual edits, input changes and switching report/service invalidate proposals', () => {
  const proposal = createReportProposal(report, { summary: 'Rename', changes: { title: 'Revised' } });
  for (const change of [{ source: 'manual' }, { values: { city: 'Boston' } }, { id: 'two' }, { serviceUrl: 'elsewhere' }]) {
    expect(() => applyReportProposal({ ...report, ...change }, proposal)).toThrow('report changed');
  }
});
test('rejects protected fields, malformed parameters and empty edits', () => {
  for (const changes of [{ id: 'two' }, { serviceUrl: 'elsewhere' }, { title: '' }, { source: 1 }, {}, { title: 'Original' }, { parameters: [{ id: 'x' }] }, { values: { n: { nested: true } } }]) {
    expect(() => createReportProposal(report, { summary: 'Bad', changes })).toThrow();
  }
  const p = { id: 'n', key: 'n', label: 'Number', type: 'number', required: true, defaultValue: 3 };
  expect(() => createReportProposal(report, { summary: 'Bad', changes: { parameters: [p, p] } })).toThrow('Duplicate');
  expect(() => createReportProposal(report, { summary: 'Bad', changes: { parameters: [p], values: { n: 'wrong' } } })).toThrow('must be a number');
});
test('agent tools expose reference and proposal capabilities alongside shared data tools', () => {
  expect(EVIDENCE_AGENT_TOOLS.map(tool => tool.name)).toEqual(expect.arrayContaining(['get_report', 'list_components', 'get_component', 'propose_report_edit', 'compile_semantic_query', 'list_catalogs', 'describe_table']));
  expect(EVIDENCE_AGENT_TOOLS.map(tool => tool.name)).toEqual(expect.arrayContaining(['run_sql', 'read_query_results', 'query_semantic_model', 'list_categories']));
});

describe('Evidence agent parameters and drill paths', () => {
  const base: EvidenceReport = { version: 1, id: 'geo', title: 'Geo', source: '# Geo', setupSql: 'SELECT $state', serviceUrl: 'https://example.com', createdAt: 1, updatedAt: 1, values: {},
    parameters: [{ id: 's', key: 'state', label: 'State', type: 'text', required: false, defaultValue: '' }] };
  test('proposes cascading choice parameters and a drill path', () => {
    const proposal = createReportProposal(base, { summary: 'Cascade', changes: {
      parameters: [
        { id: 'c', key: 'country', label: 'Country', type: 'select', required: false, defaultValue: null, allowAll: true, options: { kind: 'query', sql: 'SELECT DISTINCT country AS value FROM places' } },
        { id: 's', key: 'state', label: 'State', type: 'select', required: false, defaultValue: null, allowAll: true, options: { kind: 'query', sql: 'SELECT state FROM places WHERE ($country_all OR country = $country)' } },
      ],
      drillPaths: [{ id: 'geo', label: 'All places', levels: ['country', 'state'] }],
    } });
    expect(proposal.fields).toEqual(['parameters', 'drillPaths']);
    expect(proposal.after.drillPaths?.[0].levels).toEqual(['country', 'state']);
  });
  test('rejects choices queries that loop', () => {
    expect(() => createReportProposal(base, { summary: 'Loop', changes: { parameters: [
      { id: 'a', key: 'a', label: 'A', type: 'select', required: false, defaultValue: null, options: { kind: 'query', sql: 'SELECT $b' } },
      { id: 'b', key: 'b', label: 'B', type: 'select', required: false, defaultValue: null, options: { kind: 'query', sql: 'SELECT $a' } },
    ] } })).toThrow('loop');
  });
  test('the choices preview tool is offered, and withheld in semantic-only mode', () => {
    expect(EVIDENCE_AGENT_TOOLS.some(tool => tool.name === 'preview_parameter_options')).toBe(true);
    expect(toolsForAIQueryMode(EVIDENCE_AGENT_TOOLS, 'semantic-only').some(tool => tool.name === 'preview_parameter_options')).toBe(false);
    expect(EVIDENCE_AGENT_PROMPT).toContain('$key_all');
  });
});

describe('Evidence agent targeted edits', () => {
  const doc: EvidenceReport = { ...report, source: '# Sales\n\n```sql by_region\nSELECT region, sum(x) AS total FROM t GROUP BY 1\n```\n\n{% bar_chart data="by_region" x="region" y="total" /%}\n\n{% table data="by_region" /%}\n', setupSql: 'CREATE OR REPLACE TEMP TABLE t AS SELECT 1 AS x;\nCREATE OR REPLACE TEMP VIEW v AS SELECT 2;' };
  test('replaces one block of the source and leaves the rest byte-for-byte', () => {
    const proposal = createReportProposal(doc, { summary: 'Line chart', changes: { sourceEdits: [{ old_text: '{% bar_chart data="by_region"', new_text: '{% line_chart data="by_region"' }] } });
    expect(proposal.fields).toEqual(['source']);
    expect(proposal.after.source).toBe(doc.source.replace('bar_chart', 'line_chart'));
  });
  test('applies edits in order, each to the result of the one before, and edits setupSql too', () => {
    const proposal = createReportProposal(doc, { summary: 'Two edits', changes: {
      sourceEdits: [{ old_text: '# Sales', new_text: '# Sales by region' }, { old_text: '# Sales by region\n', new_text: '# Sales by region\n\nIntro.\n' }, { old_text: '\n{% table data="by_region" /%}\n', new_text: '' }],
      setupSqlEdits: [{ old_text: 'SELECT 1 AS x', new_text: 'SELECT $$1$$ AS x' }],
    } });
    expect(proposal.after.source.startsWith('# Sales by region\n\nIntro.\n')).toBe(true);
    expect(proposal.after.source).not.toContain('{% table');
    expect(proposal.after.setupSql).toContain('SELECT $$1$$ AS x');
    expect(proposal.fields).toEqual(['source', 'setupSql']);
  });
  test('refuses missing, ambiguous and conflicting edits without guessing', () => {
    const edit = (sourceEdits: unknown, extra = {}) => () => createReportProposal(doc, { summary: 'Bad', changes: { sourceEdits, ...extra } });
    expect(edit([{ old_text: 'no such text', new_text: 'x' }])).toThrow('not found');
    expect(edit([{ old_text: 'data="by_region"', new_text: 'x' }])).toThrow('more than once');
    expect(edit([{ old_text: '# Sales', new_text: '# X' }, { old_text: '# Sales', new_text: '# Y' }])).toThrow('edit 2 of 2');
    expect(edit([{ old_text: '# Sales', new_text: '# X' }], { source: '# Whole' })).toThrow('not both');
    expect(edit([])).toThrow();
    expect(edit([{ old_text: '', new_text: 'x' }])).toThrow();
    expect(edit([{ old_text: '# Sales', new_text: '# Sales' }])).toThrow('No changes');
  });
  test('the proposal tool offers the edit fields', () => {
    const tool = EVIDENCE_AGENT_TOOLS.find(t => t.name === 'propose_report_edit')!;
    const props = (tool.input_schema as { properties: { changes: { properties: Record<string, unknown> } } }).properties.changes.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['sourceEdits', 'setupSqlEdits']));
    expect(EVIDENCE_AGENT_PROMPT).toContain('sourceEdits');
  });
});

describe('Evidence agent source checks', () => {
  test('only issues the edit introduces count, matched by message rather than line', () => {
    const issue = (message: string, line?: number) => ({ message, severity: 'error' as const, line, target: 'document' as const });
    expect(introducedIssues([issue('Undefined tag: x', 3)], [issue('Undefined tag: x', 9)])).toEqual([]);
    expect(introducedIssues([issue('Undefined tag: x', 3)], [issue('Undefined tag: x', 3), issue('Undefined tag: x', 9)])).toEqual([issue('Undefined tag: x', 9)]);
    expect(introducedIssues([], [issue('Invalid attribute: y', 2)])).toHaveLength(1);
  });
  test('a tag that never closes is flagged; code spans and fences are not', () => {
    expect(unclosedTagIssues('# Hi\n\n{% bar_chart data="q" x="x"\n\nmore\n')).toMatchObject([{ severity: 'error', line: 3 }]);
    expect(unclosedTagIssues('Use `{% table /%}`.\n\n```sql q\nSELECT \'{%\'\n```\n\n{% table data="q" /%}\n')).toEqual([]);
  });
});
