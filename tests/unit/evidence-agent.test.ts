import { describe, expect, test } from 'bun:test';
import { createReportProposal, applyReportProposal, EVIDENCE_AGENT_TOOLS, EVIDENCE_AGENT_PROMPT } from '../../src/lib/evidence/agent';
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
