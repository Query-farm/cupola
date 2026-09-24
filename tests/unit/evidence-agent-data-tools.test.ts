import { expect, test } from 'bun:test';
import { tableFromArrays, tableToIPC } from '@query-farm/apache-arrow';
import { executeReportDataTool } from '../../src/lib/evidence/agent-data-tools';
import { QueryResultCache } from '../../src/lib/query-results';
import { EVIDENCE_AGENT_TOOLS } from '../../src/lib/evidence/agent';
import { toolsForAIQueryMode } from '../../src/lib/ai/query-mode';

test('report SQL executes and pages cached rows without repeating the query', async () => {
  const calls: string[] = [];
  const env = { resultCache: new QueryResultCache(), query: async (sql: string) => {
    calls.push(sql);
    return { ok: true, arrowBuffers: [tableToIPC(tableFromArrays({ value: Array.from({ length: 30 }, (_, i) => i) })).buffer as ArrayBuffer] };
  } };
  const result = JSON.parse((await executeReportDataTool('run_sql', { sql: 'SELECT * FROM range(30)' }, [], env, 'unrestricted-sql'))!);
  expect(result.row_count).toBe(30);
  expect(result.rows).toHaveLength(20);
  const page = JSON.parse((await executeReportDataTool('read_query_results', { result_id: result.result_id, offset: 20, limit: 10 }, [], env, 'unrestricted-sql'))!);
  expect(page.rows).toHaveLength(10);
  expect(page.rows[0].value).toBe('20.0');
  expect(calls).toEqual(['SELECT * FROM range(30)']);
  env.resultCache.clear();
  expect(await executeReportDataTool('read_query_results', { result_id: result.result_id }, [], env, 'unrestricted-sql')).toContain('not found or expired');
});

test('semantic-only mode hides SQL and rejects stale SQL tool calls before execution', async () => {
  const names = toolsForAIQueryMode(EVIDENCE_AGENT_TOOLS, 'semantic-only').map(tool => tool.name);
  expect(names).not.toContain('run_sql');
  expect(names).toContain('query_semantic_model');
  const env = { resultCache: new QueryResultCache(), query: async () => { throw new Error('Must not execute'); } };
  expect(await executeReportDataTool('run_sql', { sql: 'SELECT 1' }, [], env, 'semantic-only')).toContain('ai_query_mode_tool_denied');
});

test('SQL errors are available for repair and report tools fall through', async () => {
  const env = { resultCache: new QueryResultCache(), query: async () => ({ ok: false, error: 'Catalog Error: Table with name prices does not exist!' }) };
  await expect(executeReportDataTool('run_sql', { sql: 'SELECT * FROM prices' }, [], env, 'unrestricted-sql')).rejects.toThrow('prices does not exist');
  expect(await executeReportDataTool('get_report', {}, [], env, 'unrestricted-sql')).toBeUndefined();
});
