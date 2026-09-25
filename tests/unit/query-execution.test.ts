import { expect, test } from 'bun:test';
import { createQueryExecutor } from '../../src/lib/query-execution';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('cancelling queued work leaves the active query alone and skips execution', async () => {
  let interrupts = 0, calls = 0;
  const execute = createQueryExecutor(() => { interrupts++; });
  const active = deferred<number>();
  const first = execute(() => active.promise);
  await Promise.resolve();
  const controller = new AbortController();
  const second = execute(async () => { calls++; return 2; }, { signal: controller.signal });
  controller.abort();
  await expect(second).rejects.toThrow();
  expect(interrupts).toBe(0);
  active.resolve(1);
  expect(await first).toBe(1);
  expect(await execute(async () => 3)).toBe(3);
  expect(calls).toBe(0);
});

test('active cancellation rejects promptly but keeps the connection until work settles', async () => {
  let interrupts = 0, nextStarted = false;
  const execute = createQueryExecutor(() => { interrupts++; });
  const active = deferred<number>();
  const controller = new AbortController();
  const first = execute(() => active.promise, { signal: controller.signal });
  await Promise.resolve();
  const next = execute(async () => { nextStarted = true; return 2; });
  controller.abort(new Error('Stopped'));
  await expect(first).rejects.toThrow('Stopped');
  expect(interrupts).toBe(1);
  expect(nextStarted).toBe(false);
  active.resolve(1);
  expect(await next).toBe(2);
});

test('timeout interrupts, aborts prepared work, ignores late success and permits recovery', async () => {
  let interrupts = 0;
  let signal!: AbortSignal;
  const execute = createQueryExecutor(() => { interrupts++; });
  const active = deferred<number>();
  const first = execute(current => { signal = current; return active.promise; }, { timeoutMs: 10 });
  await expect(first).rejects.toThrow('time limit');
  expect(signal.aborted).toBe(true);
  expect(interrupts).toBe(1);
  active.resolve(1);
  expect(await execute(async () => 2)).toBe(2);
});

test('query time excludes time waiting behind another query', async () => {
  const execute = createQueryExecutor(() => { throw new Error('Unexpected interrupt'); });
  const first = execute(() => new Promise(resolve => setTimeout(resolve, 25)));
  const second = execute(async () => 2, { timeoutMs: 5 });
  await first;
  expect(await second).toBe(2);
});

test('completed work removes cancellation listeners and deadlines', async () => {
  let interrupts = 0;
  const execute = createQueryExecutor(() => { interrupts++; });
  const controller = new AbortController();
  expect(await execute(async () => 1, { signal: controller.signal, timeoutMs: 5 })).toBe(1);
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(interrupts).toBe(0);
});
