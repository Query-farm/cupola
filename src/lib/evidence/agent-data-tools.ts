import type { CatalogData } from '../service';
import { executeListCatalogs, executeListTables, executeListCategories, executeDescribeFunction } from '../ai-agent';
import { executeRunSql, executeSemanticQuery, describeTableWithFallback, type RunSqlEnv } from '../ai-tool-executor';
import { executeReadQueryResults, type QueryResultCache } from '../query-results';
import { deniedAIQueryToolResult, type AIQueryMode } from '../ai/query-mode';
import { compileSemanticQuery } from '../semantic-compiler';

/** Shared Ask AI data tools, with a report-conversation result cache. */
export async function executeReportDataTool(
  name: string,
  input: any,
  catalogs: readonly CatalogData[],
  env: RunSqlEnv & { resultCache: QueryResultCache },
  mode: AIQueryMode,
): Promise<string | undefined> {
  const denied = deniedAIQueryToolResult(name, mode);
  if (denied) return denied;
  if (name === 'list_catalogs') return executeListCatalogs(catalogs, input);
  if (name === 'list_tables') return executeListTables(catalogs, input);
  if (name === 'list_categories') return executeListCategories(catalogs, input);
  if (name === 'describe_table') return describeTableWithFallback(catalogs, env, input);
  if (name === 'describe_function') return executeDescribeFunction(catalogs, input);
  if (name === 'compile_semantic_query') return JSON.stringify(compileSemanticQuery(catalogs, { ...input, compile_only: true }));
  if (name === 'query_semantic_model') return executeSemanticQuery(catalogs, input, env);
  if (name === 'run_sql') {
    if (typeof input?.sql !== 'string' || !input.sql.trim()) throw new Error('SQL is required.');
    return executeRunSql(input.sql, env);
  }
  if (name === 'read_query_results') return executeReadQueryResults(env.resultCache, input.result_id, input.offset, input.limit);
}
