import type { Table } from '@query-farm/apache-arrow';
import { decodeArrowBuffer } from '../duckdb-query';
import type { QueryResult } from '../shell-bridge';
import { isReadOnlySql, splitStatements } from '../evidence/setup-test';
import type { SqlCell } from './model';
import { compileNotebookQuery, type ParameterScope, type ParameterValue } from './parameters';

export type RunPhase =
  | 'waiting'
  | 'queued'
  | 'validating'
  | 'executing'
  | 'decoding'
  | 'complete'
  | 'failed'
  | 'cancelled';
export const PHASE_LABELS: Record<RunPhase, string> = {
  waiting: 'Waiting for engine',
  queued: 'Queued',
  validating: 'Validating SQL',
  executing: 'Executing query',
  decoding: 'Reading result',
  complete: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export interface RunRecord {
  number: number;
  mode: 'query' | 'explain';
  source: string;
  sql: string;
  params: unknown[];
  values: Record<string, ParameterValue>;
  serviceUrl: string;
  sessionId: string;
  engineVersion?: string;
  startedAt: number;
  completedAt?: number;
  elapsedMs?: number;
  phase: RunPhase;
  rows?: number;
  error?: string;
}
export interface ResultSnapshot {
  table: Table;
  provenance: RunRecord;
}
export interface NotebookRunOptions extends ParameterScope {
  serviceUrl?: string;
  sessionId?: string;
  engineVersion?: string;
  mode?: 'query' | 'explain';
}
export interface NotebookQueryContext {
  params: unknown[];
  mode: 'query' | 'explain';
  phase: (phase: RunPhase) => void;
}

export interface CellResult {
  table?: Table;
  source?: string;
  completedAt?: number;
  elapsedMs?: number;
  running?: boolean;
  error?: string;
  cancelled?: boolean;
  attempt?: RunRecord;
  provenance?: RunRecord;
  history?: RunRecord[];
  pinned?: ResultSnapshot;
  plan?: Table;
  planProvenance?: RunRecord;
}
export function isStale(cell: SqlCell, result?: CellResult, scope: ParameterScope = {}): boolean {
  if (!result?.table) return false;
  if (result.source !== cell.source) return true;
  if (result.attempt?.mode !== 'explain' && (result.running || result.error || result.cancelled)) return true;
  const lastQuery = result.history?.find((run) => run.mode === 'query');
  if (lastQuery?.phase === 'failed' || lastQuery?.phase === 'cancelled') return true;
  try {
    const compiled = compileNotebookQuery(cell.source, scope);
    return JSON.stringify(compiled.params) !== JSON.stringify(result.provenance?.params ?? []);
  } catch {
    return true;
  }
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
  private sequence = 0;
  private history = new Map<string, RunRecord[]>();
  constructor(
    private query: (sql: string, signal: AbortSignal, context: NotebookQueryContext) => Promise<QueryResult>,
    private publish: (id: string, update: Partial<CellResult>) => void,
  ) {}
  get running() {
    return this.active !== null;
  }
  stop() {
    this.active?.abort();
  }
  async run(cells: SqlCell[], options: NotebookRunOptions = {}): Promise<void> {
    if (this.active) return;
    const controller = new AbortController();
    this.active = controller;
    // Freeze the whole batch, including values changed while a preceding cell runs.
    const snapshot = structuredClone({ cells, options });
    try {
      for (const cell of snapshot.cells) {
        if (controller.signal.aborted) break;
        const start = performance.now();
        const mode = snapshot.options.mode ?? 'query';
        let record: RunRecord = {
          number: ++this.sequence,
          mode,
          source: cell.source,
          sql: cell.source,
          params: [],
          values: {},
          serviceUrl: snapshot.options.serviceUrl ?? '',
          sessionId: snapshot.options.sessionId ?? '',
          engineVersion: snapshot.options.engineVersion,
          startedAt: Date.now(),
          phase: 'waiting',
        };
        const phase = (value: RunPhase) => {
          if (controller.signal.aborted) return;
          record = { ...record, phase: value };
          this.publish(cell.id, { attempt: record });
        };
        this.publish(cell.id, {
          running: true,
          error: undefined,
          cancelled: false,
          attempt: record,
          ...(mode === 'explain' ? { plan: undefined, planProvenance: undefined } : {}),
        });
        try {
          validateCellSql(cell.source);
          const compiled = compileNotebookQuery(cell.source, snapshot.options);
          record = {
            ...record,
            sql: mode === 'explain' ? `EXPLAIN ${compiled.sql}` : compiled.sql,
            params: compiled.params,
            values: compiled.values,
          };
          phase('waiting');
          const response = await this.query(compiled.sql, controller.signal, {
            params: compiled.params,
            mode,
            phase,
          });
          controller.signal.throwIfAborted();
          if (!response.ok) throw new Error(response.error || 'Query failed');
          if (response.arrowBuffers?.length !== 1) throw new Error('Expected one tabular result.');
          phase('decoding');
          const table = decodeArrowBuffer(response.arrowBuffers[0]);
          record = {
            ...record,
            phase: 'complete',
            completedAt: Date.now(),
            elapsedMs: Math.round(performance.now() - start),
            rows: table.numRows,
          };
          this.publish(cell.id, {
            ...(mode === 'explain'
              ? { plan: table, planProvenance: record }
              : {
                  table,
                  source: cell.source,
                  completedAt: record.completedAt,
                  elapsedMs: record.elapsedMs,
                  provenance: record,
                }),
            attempt: record,
            running: false,
            error: undefined,
            cancelled: false,
          });
        } catch (error) {
          record = {
            ...record,
            phase: controller.signal.aborted ? 'cancelled' : 'failed',
            completedAt: Date.now(),
            elapsedMs: Math.round(performance.now() - start),
            error: controller.signal.aborted
              ? undefined
              : error instanceof Error
                ? error.message
                : String(error),
          };
          this.publish(cell.id, {
            attempt: record,
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
        } finally {
          const history = [record, ...(this.history.get(cell.id) ?? [])].slice(0, 10);
          this.history.set(cell.id, history);
          this.publish(cell.id, { history });
        }
      }
    } finally {
      if (this.active === controller) this.active = null;
    }
  }
}
