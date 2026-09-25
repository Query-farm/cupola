import type { SemanticDatasetState } from './semantic-datasets';
import type { HaybarnQueryService } from './haybarn-query-service';

/** The active renderer's query registry and shared engine adapter. */
export interface EvidenceDataContext {
  service: HaybarnQueryService;
  semanticStates: SemanticDatasetState[];
  queries: { name: string; sql: string }[];
  resolve: (name: string) => string;
}
export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const TABLE_BROWSER_SQL = `SELECT database_name, schema_name, table_name AS name, 'table' AS kind
FROM duckdb_tables() WHERE NOT internal
UNION ALL
SELECT database_name, schema_name, view_name AS name, 'view' AS kind
FROM duckdb_views() WHERE NOT internal
ORDER BY database_name, schema_name, name`;

export function resolveBrowserDataset(context: EvidenceDataContext, id: string): string {
  if (id.startsWith('query:')) return context.resolve(id.slice(6));
  if (id.startsWith('table:')) {
    const path: unknown = JSON.parse(id.slice(6));
    if (!Array.isArray(path) || path.length !== 3 || !path.every(part => typeof part === 'string')) throw new Error('Invalid table reference');
    return `SELECT * FROM ${path.map(quoteIdentifier).join('.')}`;
  }
  throw new Error('Dataset is unavailable. Choose it again in Browse data.');
}
