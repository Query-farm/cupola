import type { AsyncDuckDB, AsyncDuckDBConnection } from '@haybarn/haybarn-wasm';
import type { EngineConnection, QueryResult } from './shell-bridge';
import type { QueryExecutionOptions, createQueryExecutor } from './query-execution';
import { pendingQuery, parameterVariableSql } from './pending-query';

/** All sessions share the worker's scheduler. In particular, a connection must
 * not reset the worker-wide cancel SAB or change global thread settings while
 * another connection owns a query. Its interrupt flag, however, is its own. */
export async function scopedConnection(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  execute: ReturnType<typeof createQueryExecutor>,
  cancelInt32: Int32Array | null,
  setInterrupt: (interrupt: (() => void) | null) => void,
  interruptible: <T>(signal: AbortSignal, work: () => Promise<T>) => Promise<T>,
): Promise<EngineConnection> {
  const id = conn.useUnsafe((_db, value) => value);
  const handle = await db.getInterruptHandle(id);
  const flag = handle ? new Uint8Array(handle.memory, handle.offset, 1) : null;
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const prefix = `__cupola_session_${crypto.randomUUID().replaceAll('-', '')}_`;
  let sequence = 0;
  const resetCancel = () => {
    if (cancelInt32) Atomics.store(cancelInt32, 0, 0);
  };
  const interrupt = () => {
    if (flag) Atomics.store(flag, 0, 1);
    if (cancelInt32) Atomics.store(cancelInt32, 0, 1);
    else void conn.cancelSent().catch(error => console.warn('Query cancellation failed', error));
  };
  const copied = (bytes: Uint8Array): QueryResult => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return { ok: true, arrowBuffers: [copy.buffer] };
  };
  const prepared = async (sql: string, params: unknown[], signal: AbortSignal) => {
    signal.throwIfAborted();
    const statement = await db.createPrepared(id, sql);
    try {
      signal.throwIfAborted();
      return await db.runPrepared(id, statement, params);
    } finally {
      await db.closePrepared(id, statement);
    }
  };
  const bound = async (sql: string, params: unknown[], signal: AbortSignal, variables: string[]) => {
    signal.throwIfAborted();
    if (params.length) {
      const names = params.map((_, index) => `${prefix}${sequence}_${index}`);
      sequence++;
      sql = parameterVariableSql(sql, await db.tokenize(sql), names);
      for (const [index, value] of params.entries()) {
        const integer = typeof value === 'number' && Number.isSafeInteger(value);
        await prepared(`SET VARIABLE "${names[index]}" = ?${integer ? '::BIGINT' : ''}`, [value], signal);
        variables.push(names[index]);
      }
    }
    return copied(await pendingQuery(db, id, sql, signal));
  };
  const resetVariables = async (names: string[]) => {
    for (const name of names) await db.runQuery(id, `RESET VARIABLE "${name}"`);
  };
  const submit = <T>(work: (signal: AbortSignal) => Promise<T>, options: QueryExecutionOptions = {}) => {
    lifetime.signal.throwIfAborted();
    return execute(async signal => {
      resetCancel();
      setInterrupt(interrupt);
      try { return await interruptible(signal, () => work(signal)); }
      finally { resetCancel(); setInterrupt(null); }
    }, { ...options, signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal });
  };
  const queryPrepared: EngineConnection['queryPrepared'] = (sql, params, options) => submit(async signal => {
    const variables: string[] = [];
    try { return await bound(sql, params, signal, variables); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { resetCancel(); await resetVariables(variables); }
  }, options);
  return {
    query: (sql, options) => queryPrepared(sql, [], options),
    queryPrepared,
    transaction: (work, options) => submit(async signal => {
      const variables: string[] = [];
      let committed = false;
      await db.runQuery(id, 'BEGIN TRANSACTION');
      try {
        const result = await work((sql, params = []) => bound(sql, params, signal, variables));
        signal.throwIfAborted();
        await db.runQuery(id, 'COMMIT');
        committed = true;
        return result;
      } finally {
        resetCancel();
        if (!committed) await db.runQuery(id, 'ROLLBACK');
        await resetVariables(variables);
      }
    }, options),
    close: () => {
      if (!closing) {
        lifetime.abort(new DOMException('Notebook session closed.', 'AbortError'));
        // The executor retains ownership until interrupted work and rollback
        // settle. Never disconnect a connection still in use by the worker.
        closing = execute(() => conn.close());
      }
      return closing;
    },
  };
}
