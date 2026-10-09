import { bytesFromBase64, bytesToBase64, errorCode, type Input, type Method, type Output, type ReportClient } from './client';

const PREFIX = 'cupola.reporting.mutation.v1:';
export const serializeJournal = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $int64: item.toString() } : item instanceof Uint8Array ? { $bytes: bytesToBase64(item) } : item);
export const parseJournal = (value: string) => JSON.parse(value, (_key, item) => item && typeof item === 'object' && Object.keys(item).length === 1 ? '$int64' in item ? BigInt(item.$int64) : '$bytes' in item ? bytesFromBase64(item.$bytes) : item : item);
export interface PendingMutation { method: Method; input: Record<string, any>; createdAt: number; scope: string }
// These statuses explicitly refuse admission. Transport/server failures remain ambiguous.
const REFUSED = new Set(['ABORTED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'ALREADY_EXISTS', 'FAILED_PRECONDITION', 'RESOURCE_EXHAUSTED']);
const localLocks = new Map<string, Promise<void>>();

/** Write ahead of dispatch. An uncertain request keeps its exact ID, preconditions and bytes. */
export class MutationJournal {
  readonly key: string;
  private busy = false;
  constructor(readonly client: ReportClient, readonly scope: string, id: string, private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage) {
    this.key = PREFIX + scope + ':' + id;
  }
  get pending(): PendingMutation | null {
    const raw = this.storage.getItem(this.key);
    return raw ? parseJournal(raw) : null;
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(this.key, action);
    // Tests/non-browser consumers also serialize multiple instances sharing one journal.
    const previous = localLocks.get(this.key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    localLocks.set(this.key, current);
    await previous;
    try { return await action(); }
    finally { release(); if (localLocks.get(this.key) === current) localLocks.delete(this.key); }
  }
  async run<M extends Method>(method: M, input: Omit<Input<M>, 'request_id'>): Promise<Output<M>> {
    return this.exclusive(async () => {
      if (this.busy || this.pending) throw new Error('Resolve the pending request before starting another change.');
      const pending: PendingMutation = { method, input: { ...input, request_id: crypto.randomUUID() }, createdAt: Date.now(), scope: this.scope };
      this.storage.setItem(this.key, serializeJournal(pending)); // A full disk must prevent dispatch.
      return this.dispatch() as Promise<Output<M>>;
    });
  }
  async retry(): Promise<any> {
    return this.exclusive(() => this.dispatch());
  }
  private async dispatch(): Promise<any> {
    if (this.busy) throw new Error('A request is already in progress.');
    const pending = this.pending;
    if (!pending) throw new Error('There is no pending request.');
    // v1 guarantees only a 24-hour replay window. Do not silently re-admit an expired request.
    if (Date.now() - pending.createdAt >= 24 * 60 * 60 * 1000) throw new Error('This request is older than the replay window. Check the worker before discarding it or saving a copy.');
    if (await this.client.recoveryScope() !== pending.scope) throw new Error('The signed-in account changed. Return to the original account to retry this request.');
    this.busy = true;
    try {
      const result = await this.client.call(pending.method, pending.input as never);
      this.storage.removeItem(this.key);
      return result;
    } catch (error) {
      if (REFUSED.has(errorCode(error) ?? '')) this.storage.removeItem(this.key);
      throw error;
    } finally { this.busy = false; }
  }
  async discard(): Promise<void> {
    return this.exclusive(async () => { this.storage.removeItem(this.key); });
  }
}
