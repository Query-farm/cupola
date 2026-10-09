import { httpConnect } from '@query-farm/vgi-rpc/connect';
import { deserializeSchema, serializeBatch, singleRowBatch } from '@query-farm/vgi-rpc/arrow';
import { tableFromIPC } from '@query-farm/apache-arrow';
import { getAuthTokenForService } from '../auth';
import { methodConfig, recordSchemas, REPORTS_PROTOCOL, type ReportMethods } from './contracts.generated';

export type Method = keyof ReportMethods;
export type Input<M extends Method> = ReportMethods[M]['input'];
export type Output<M extends Method> = ReportMethods[M]['output'];
export const bytesFromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export function bytesToBase64(value: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < value.length; offset += 8192) result += String.fromCharCode(...value.subarray(offset, offset + 8192));
  return btoa(result);
}

/** Only credential-free HTTP endpoints may become portable attachment/share references. */
export function serviceLocation(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('A report library needs an HTTP(S) service URL without credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/$/, '');
}

// Arrow StructRows and ListVectors are views, not JSON objects. Preserve binary and int64.
export function plain(value: any): any {
  if (value == null || typeof value !== 'object' || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value.toJSON === 'function') return plain(value.toJSON());
  if (typeof value.toArray === 'function') return Array.from(value.toArray(), plain);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}

export function encodeRecord(name: string, value: object): Uint8Array {
  const schema = deserializeSchema(bytesFromBase64(recordSchemas[name]));
  return serializeBatch(singleRowBatch(schema, value));
}

export function decodeRecord(value: unknown): any {
  if (!(value instanceof Uint8Array)) throw new Error('The report worker returned an invalid record.');
  const batch = tableFromIPC(value);
  if (batch.numRows !== 1) throw new Error('The report worker must return exactly one record.');
  return plain(batch.get(0));
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'errorCode' in error ? String(error.errorCode) : undefined;
}
export function reportError(error: unknown): string {
  const code = errorCode(error);
  if (code === 'ABORTED') return 'This item changed on the worker. Your draft is safe; reload the latest version or save a copy.';
  if (code === 'NOT_FOUND') return 'This item is no longer available, or your access has changed.';
  if (code === 'PERMISSION_DENIED' || code === 'UNAUTHENTICATED') return 'The worker did not allow this action. Sign in with an authorized account, then retry.';
  // RPC errors carry a sanitized service message separately from their debugging stack.
  if (error && typeof error === 'object' && 'errorMessage' in error) return String(error.errorMessage);
  return error instanceof Error ? error.message : 'Could not reach the report worker.';
}

export class ReportClient {
  readonly url: string;
  constructor(url: string, private options: { token?: () => Promise<string | null>; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.url = serviceLocation(url);
  }
  private token() { return this.options.token ? this.options.token() : getAuthTokenForService(this.url); }
  /** Partition local recovery by credentials, without persisting the credential itself. */
  async recoveryScope(): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await this.token() ?? 'anonymous'));
    return `${this.url}:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
  }
  private async connection(protocol?: string, signal?: AbortSignal) {
    const token = await this.token();
    const transport = this.options.fetch ?? globalThis.fetch;
    const scopedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      // Do not forward credentials to redirects or externalized object storage URLs.
      const target = new URL(input instanceof Request ? input.url : String(input));
      const base = new URL(this.url);
      const headers = new Headers(init?.headers);
      headers.delete('Authorization');
      if (target.origin === base.origin && (target.pathname === base.pathname || target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) && token) headers.set('Authorization', `Bearer ${token}`);
      return transport(input, { ...init, headers, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    }) as typeof fetch;
    return httpConnect(this.url, { protocol, fetch: scopedFetch });
  }
  async discover(signal?: AbortSignal): Promise<boolean> {
    const rpc = await this.connection(undefined, signal);
    try { const info = await rpc.describe(); return info.protocolName === REPORTS_PROTOCOL || info.hostedProtocols?.includes(REPORTS_PROTOCOL) === true; }
    finally { rpc.close(); }
  }
  async call<M extends Method>(method: M, input: Input<M>, signal?: AbortSignal): Promise<Output<M>> {
    const config = methodConfig[method];
    const params: Record<string, any> = { ...config.defaults, ...input };
    for (const [key, name] of Object.entries(config.structured)) if (params[key] != null) params[key] = encodeRecord(name, params[key]);
    const rpc = await this.connection(REPORTS_PROTOCOL, signal);
    try {
      if (!config.stream) return decodeRecord((await rpc.call(method, params))?.result);
      const stream = await rpc.stream(method, params);
      try {
        const rows: unknown[] = [];
        for await (const batch of stream) rows.push(...batch.map(row => {
          const result = plain(row);
          // The SDK converts safe top-level int64 values to Number. Keep our contract uniform.
          for (const key of ['version', 'revision_number']) if (result[key] != null) result[key] = BigInt(result[key]);
          return result;
        }));
        return rows as Output<M>;
      } finally { stream.close(); }
    } finally { rpc.close(); }
  }
}
