import type { Table } from '@query-farm/apache-arrow';
import { decodeArrowBuffer, quoteIdent } from '../duckdb-query';
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
  cells?: SqlCell[];
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
  upstreamInputs?: string;
  dependencyStale?: boolean;
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
export function isStale(cell: SqlCell, result?: CellResult, scope: UpstreamScope = {}): boolean {
  if (!result?.table) return false;
  if (result.dependencyStale || (result.upstreamInputs ?? '[]') !== upstreamInputs(cell.id, scope)) return true;
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
export interface CellSql {
  sql: string;
  query: string;
  table?: string;
}

/** Only materialize a SELECT, never arbitrary DDL or a script. Reconstruct the
 * prefix so quoted names cannot escape the connection-local temp namespace. */
export function parseCellSql(sql: string): CellSql {
  if (!sql.trim()) throw new Error('Enter a SQL query first.');
  const statements = splitStatements(sql);
  const gap = '(?:\\s|--[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)';
  const create = new RegExp(`^${gap}*CREATE${gap}+(OR${gap}+REPLACE${gap}+)?TEMP(?:ORARY)?${gap}+TABLE${gap}+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)${gap}+AS${gap}+([\\s\\S]+)$`, 'i');
  const match = statements.length === 1 ? create.exec(statements[0]) : null;
  if (match && isReadOnlySql(match[3])) {
    const table = match[2].startsWith('"') ? match[2].slice(1, -1).replaceAll('""', '"') : match[2];
    return { table, query: match[3], sql: `CREATE ${match[1] ? 'OR REPLACE ' : ''}TEMP TABLE ${quoteIdent(table)} AS\n${match[3]}` };
  }
  if (statements.length === 1 && isReadOnlySql(sql)) return { sql, query: sql };
  throw new Error('Each notebook SQL cell accepts one read query or CREATE [OR REPLACE] TEMP TABLE name AS SELECT …. Use the Query Editor for scripts or changes to stored data.');
}
export function validateCellSql(sql: string): void {
  parseCellSql(sql);
}

/** Conservatively track preceding setup cells. No automatic execution: edits
 * mark downstream results stale, and Run changed reruns them in document order. */
type SetupInput = {
  source: string;
  params: unknown[];
  revision: number;
  dependencies: [string, number][];
  stale: boolean;
};
type UpstreamScope = ParameterScope & { cells?: { id: string; type: string; source: string }[] };
export function upstreamInputs(id: string, scope: UpstreamScope): string {
  return upstreamState(id, scope).fingerprint;
}
function upstreamState(id: string, scope: UpstreamScope, executed?: Map<string, SetupInput>) {
  const inputs: unknown[] = [];
  const versions: [string, number][] = [];
  for (const cell of scope.cells ?? []) {
    if (cell.id === id) break;
    if (cell.type !== 'sql') continue;
    try {
      if (!parseCellSql(cell.source).table) continue;
      const actual = executed?.get(cell.id);
      if (!executed) inputs.push([cell.id, cell.source, compileNotebookQuery(cell.source, scope).params]);
      else if (!actual) inputs.push([cell.id, null, 'not run']);
      else {
        // Keep versions flat: nesting every preceding cell's lineage would
        // grow exponentially. A stale derived table stays stale even if its
        // consumers are rerun or its displayed output has been cleared.
        const changed = actual.stale || JSON.stringify(actual.dependencies) !== JSON.stringify(versions);
        inputs.push([cell.id, actual.source, actual.params, ...(changed ? ['upstream changed'] : [])]);
      }
    } catch {
      // An invalid upstream edit must not make dependent output look current.
      const actual = executed?.get(cell.id);
      inputs.push(actual ? [cell.id, actual.source, actual.params] : [cell.id, cell.source, 'invalid']);
    }
    versions.push([cell.id, executed?.get(cell.id)?.revision ?? 0]);
  }
  return { fingerprint: JSON.stringify(inputs), versions };
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
  private setupInputs = new Map<string, SetupInput>();
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
  reset() {
    if (this.active) throw new Error('Stop the notebook run before resetting its session.');
    this.sequence = 0;
    this.history.clear();
    this.setupInputs.clear();
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
          const upstream = upstreamState(cell.id, snapshot.options, this.setupInputs);
          if (mode === 'query' && parseCellSql(cell.source).table)
            this.setupInputs.set(cell.id, {
              source: cell.source,
              params: compiled.params,
              revision: record.number,
              dependencies: upstream.versions,
              stale: upstream.fingerprint !== upstreamInputs(cell.id, snapshot.options),
            });
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
                  upstreamInputs: upstream.fingerprint,
                  dependencyStale: false,
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
