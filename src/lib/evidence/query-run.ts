import { engine } from '../shell-bridge';

export const REPORT_QUERY_TIMEOUT_MS = 60_000;

/** One refresh owns setup, semantic datasets, and all subsequent renderer queries. */
export class EvidenceQueryRun {
  private controller = new AbortController();
  private pending = 0;
  readonly signal = this.controller.signal;

  constructor(private onActivity: (pending: number) => void = () => {}) {}

  stop() {
    this.controller.abort(new DOMException('Report refresh stopped.', 'AbortError'));
  }

  /** Cancel readiness waits without leaving a listener behind. */
  async wait<T>(pending: Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    let abort: () => void = () => {};
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        abort = () => reject(this.signal.reason);
        this.signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally {
      this.signal.removeEventListener('abort', abort);
    }
  }

  async query(sql: string, params: unknown[] = [], signal?: AbortSignal) {
    const combined = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
    combined.throwIfAborted();
    if (!engine.query) throw new Error('Haybarn is not ready');
    if (params.length && !engine.queryPrepared) throw new Error('Prepared queries are unavailable');
    this.onActivity(++this.pending);
    try {
      const options = { signal: combined, timeoutMs: REPORT_QUERY_TIMEOUT_MS };
      const result = params.length
        ? await engine.queryPrepared!(sql, params, options)
        : await engine.query(sql, options);
      combined.throwIfAborted();
      return result;
    } finally {
      this.onActivity(--this.pending);
    }
  }
}
