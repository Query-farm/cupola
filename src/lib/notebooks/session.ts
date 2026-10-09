import { engine, waitForEngineReady, type EngineConnection } from '../shell-bridge';
import { quoteIdent, decodeArrowBuffer } from '../duckdb-query';
import { parseCellSql, validateSelectQuery, type NotebookQueryContext } from './execution';
import type { QueryExecutionOptions } from '../query-execution';

const TIMEOUT_MS = 180_000;

/** One open notebook owns one lazy connection, including its assistant's reads.
 * Closing during boot still closes the eventual connection; it cannot leak. */
export class NotebookSession {
  private pending?: Promise<EngineConnection>;
  private lifetime = new AbortController();
  private closing?: Promise<void>;

  private connection(): Promise<EngineConnection> {
    this.lifetime.signal.throwIfAborted();
    if (!this.pending) {
      this.pending = (async () => {
        await waitForEngineReady();
        this.lifetime.signal.throwIfAborted();
        if (!engine.openConnection) throw new Error('Notebook connections are unavailable.');
        const connection = await engine.openConnection();
        try {
          this.lifetime.signal.throwIfAborted();
          const { alias, schema } = engine.defaultCatalog;
          if (alias) {
            const result = await connection.query(`USE ${quoteIdent(alias)}${schema ? `.${quoteIdent(schema)}` : ''}`);
            if (!result.ok) throw new Error(result.error);
          }
          return connection;
        } catch (error) {
          await connection.close();
          throw error;
        }
      })();
    }
    return this.pending;
  }

  private async ready(signal?: AbortSignal): Promise<EngineConnection> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    combined.throwIfAborted();
    let abort = () => {};
    try {
      return await Promise.race([
        this.connection(),
        new Promise<never>((_, reject) => {
          abort = () => reject(combined.reason);
          combined.addEventListener('abort', abort, { once: true });
          if (combined.aborted) abort();
        }),
      ]);
    } finally {
      combined.removeEventListener('abort', abort);
    }
  }

  async query(sql: string, params: unknown[] = [], options: QueryExecutionOptions = {}) {
    const connection = await this.ready(options.signal);
    return connection.queryPrepared(sql, params, { timeoutMs: TIMEOUT_MS, ...options });
  }

  async runCell(sql: string, signal: AbortSignal, context: NotebookQueryContext) {
    const parsed = parseCellSql(sql);
    const connection = await this.ready(signal);
    signal.throwIfAborted();
    context.phase('queued');
    await validateSelectQuery(parsed.query, (text, params) => connection.queryPrepared(text, params, {
      signal, timeoutMs: TIMEOUT_MS, onStart: () => context.phase('validating'),
    }));
    context.phase('queued');
    const options = { signal, timeoutMs: TIMEOUT_MS, onStart: () => context.phase('executing') };
    if (context.mode === 'explain' || !parsed.table)
      return connection.queryPrepared(context.mode === 'explain' ? `EXPLAIN ${parsed.sql}` : parsed.sql, context.params, options);
    return connection.transaction(async query => {
      await query(parsed.sql, context.params);
      const result = await query(`SELECT * FROM temp.main.${quoteIdent(parsed.table!)}`);
      // Decode before committing: failure or cancellation preserves both the
      // previous temporary table and the cell's previous displayed output.
      decodeArrowBuffer(result.arrowBuffers![0]);
      signal.throwIfAborted();
      return result;
    }, options);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort(new DOMException('Notebook session closed.', 'AbortError'));
      this.closing = this.pending
        ? this.pending.then(connection => connection.close(), () => {})
        : Promise.resolve();
    }
    return this.closing;
  }
}
