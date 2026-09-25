import { expect, test } from 'bun:test';
import { createReportProposal, applyReportProposal, EVIDENCE_AGENT_TOOLS } from '../../src/lib/evidence/agent';
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
