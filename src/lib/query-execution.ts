export interface QueryExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Keep ownership of the shared connection until an interrupted query settles.
 * Queued cancellation must never interrupt the query ahead of it. */
export function createQueryExecutor(interrupt: () => void) {
  let tail: Promise<unknown> = Promise.resolve();
  return function execute<T>(work: (signal: AbortSignal) => Promise<T>, options: QueryExecutionOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let running = false, finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.abort(reason);
        // A failed interrupt must not prevent the caller from being released.
        try { if (running) interrupt(); } catch (error) { console.warn('Query cancellation failed', error); }
        reject(reason);
      };
      const abort = () => stop(options.signal?.reason ?? new DOMException('Query cancelled', 'AbortError'));
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      tail = tail.then(async () => {
        if (finished) return;
        running = true;
        const timeoutMs = options.timeoutMs;
        if (timeoutMs !== undefined) timer = setTimeout(() => stop(new Error(`Query exceeded the ${timeoutMs / 1000}-second time limit.`)), timeoutMs);
        try {
          const result = await work(controller.signal);
          if (!finished) resolve(result);
        } catch (error) {
          if (!finished) reject(error);
        } finally {
          running = false;
          finished = true;
          cleanup();
        }
      });
    });
  };
}
