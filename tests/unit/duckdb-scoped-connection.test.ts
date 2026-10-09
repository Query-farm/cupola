import { expect, test } from 'bun:test';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@haybarn/haybarn-wasm';
import { createQueryExecutor } from '../../src/lib/query-execution';
import { scopedConnection } from '../../src/lib/duckdb-scoped-connection';

test('disconnect waits for interrupted SQL, rollback and variable cleanup, and runs only once', async () => {
  const events: string[] = [];
  let interrupt: (() => void) | null = null;
  let finish!: (bytes: Uint8Array) => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const bytes = new Uint8Array([1]);
  const db = {
    getInterruptHandle: async () => null,
    tokenize: async (sql: string) => ({ offsets: [sql.indexOf('?')], types: [3] }),
    createPrepared: async () => 1,
    runPrepared: async () => { events.push('bind'); return bytes; },
    closePrepared: async () => {},
    runQuery: async (_id: number, sql: string) => { events.push(sql.startsWith('RESET VARIABLE') ? 'reset variable' : sql); return bytes; },
    startPendingQuery: () => {
      events.push('start');
      notifyStarted();
      return new Promise<Uint8Array>(resolve => { finish = resolve; });
    },
  } as unknown as AsyncDuckDB;
  const conn = {
    useUnsafe: (read: (db: AsyncDuckDB, id: number) => unknown) => read(db, 7),
    cancelSent: async () => { events.push('interrupt'); },
    close: async () => { events.push('disconnect'); },
  } as unknown as AsyncDuckDBConnection;
  const execute = createQueryExecutor(() => interrupt?.());
  const session = await scopedConnection(db, conn, execute, null, value => { interrupt = value; }, async (_signal, work) => work());
  const pending = session.transaction(query => query('CREATE TEMP TABLE x AS SELECT ?', [42]));
  await started;
  const closing = session.close();
  await expect(pending).rejects.toThrow('session closed');
  expect(events).toEqual(['BEGIN TRANSACTION', 'bind', 'start', 'interrupt']);
  finish(bytes);
  await closing;
  await session.close();
  expect(events).toEqual(['BEGIN TRANSACTION', 'bind', 'start', 'interrupt', 'ROLLBACK', 'reset variable', 'disconnect']);
  expect(interrupt).toBeNull();
});
