import type { Table } from '@query-farm/apache-arrow';
import { decodeArrowBuffer } from '../duckdb-query';
import type { QueryResult } from '../shell-bridge';
import { isReadOnlySql, splitStatements } from '../evidence/setup-test';
import type { SqlCell } from './model';

export interface CellResult {
  table?: Table;
  source?: string;
  completedAt?: number;
  elapsedMs?: number;
  running?: boolean;
  error?: string;
  cancelled?: boolean;
}
export function isStale(cell: SqlCell, result?: CellResult): boolean {
  return (
    !!result?.table &&
    (result.source !== cell.source || !!result.running || !!result.error || !!result.cancelled)
  );
}
export function validateCellSql(sql: string): void {
  if (!sql.trim()) throw new Error('Enter a SQL query first.');
  if (splitStatements(sql).length !== 1 || !isReadOnlySql(sql))
    throw new Error(
      'Each notebook SQL cell accepts one read query. Use the Query Editor for scripts or changes to data.',
    );
}

/** Use DuckDB's parser before execution: a leading WITH can also prefix DELETE or UPDATE.
 * JSON serialization only accepts SELECT statements (including WITH/FROM/VALUES forms).
 * The SQL is bound as data; validating it cannot execute the submitted statement. */
export async function validateSelectQuery(
  sql: string,
  query: (sql: string, params: unknown[]) => Promise<QueryResult>,
): Promise<void> {
  const result = await query('SELECT json_serialize_sql(?) AS parsed', [sql]);
  if (!result.ok || !result.arrowBuffers?.length)
    throw new Error(result.error || 'Unable to validate notebook SQL.');
  const parsed = JSON.parse(String(decodeArrowBuffer(result.arrowBuffers[0]).getChildAt(0)?.get(0)));
  if (parsed.error || parsed.statements?.length !== 1)
    throw new Error(
      `Notebook cells accept one SELECT query, including WITH and VALUES. ${parsed.error_message || 'Use the Query Editor for other statements.'}`,
    );
}

/** One run owns cancellation and sequencing. A stopped or disposed run can never publish a late result. */
export class NotebookRunner {
  private active: AbortController | null = null;
  constructor(
    private query: (sql: string, signal: AbortSignal) => Promise<QueryResult>,
    private publish: (id: string, update: Partial<CellResult>) => void,
  ) {}
  get running() {
    return this.active !== null;
  }
  stop() {
    this.active?.abort();
  }
  async run(cells: SqlCell[]): Promise<void> {
    if (this.active) return;
    const controller = new AbortController();
    this.active = controller;
    try {
      for (const cell of cells) {
        if (controller.signal.aborted) break;
        const start = performance.now();
        this.publish(cell.id, { running: true, error: undefined, cancelled: false });
        try {
          validateCellSql(cell.source);
          const response = await this.query(cell.source, controller.signal);
          controller.signal.throwIfAborted();
          if (!response.ok) throw new Error(response.error || 'Query failed');
          if (response.arrowBuffers?.length !== 1) throw new Error('Expected one tabular result.');
          const table = decodeArrowBuffer(response.arrowBuffers[0]);
          this.publish(cell.id, {
            table,
            source: cell.source,
            completedAt: Date.now(),
            elapsedMs: Math.round(performance.now() - start),
            running: false,
            error: undefined,
            cancelled: false,
          });
        } catch (error) {
          this.publish(cell.id, {
            running: false,
            cancelled: controller.signal.aborted,
            error: controller.signal.aborted
              ? undefined
              : error instanceof Error
                ? error.message
                : String(error),
          });
          // Run all stops at the first failure so it cannot obscure an incomplete analysis.
          break;
        }
      }
    } finally {
      if (this.active === controller) this.active = null;
    }
  }
}
