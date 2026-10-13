import { httpConnect } from '@query-farm/vgi-rpc/connect';
import { deserializeSchema, serializeBatch, singleRowBatch } from '@query-farm/vgi-rpc/arrow';
import { tableFromIPC } from '@query-farm/apache-arrow';
import { getAuthTokenForService } from '../auth';
import { connectionErrorMessage } from '../connection-errors';
import { methodConfig, recordSchemas, REPORTS_PROTOCOL, type ReportMethods } from './contracts.generated';
import { fromObject, fromScheduleV2, kindForFormat, toScheduleV2 } from './object-adapter';
import { REPORT_LIBRARY_CHANGED } from './navigation';

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
  private advertised?: Promise<Set<string>>;
  private advertisedMethods = new Map<string, Promise<Set<string>>>();
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
      try {
        return await transport(input, { ...init, headers, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (error) {
        const message = connectionErrorMessage(error, target.href);
        if (error instanceof Error && message !== error.message) throw new TypeError(message, { cause: error });
        throw error;
      }
    }) as typeof fetch;
    return httpConnect(this.url, { protocol, fetch: scopedFetch });
  }
  private protocols(signal?: AbortSignal): Promise<Set<string>> {
    if (!this.advertised) this.advertised = (async () => {
      const rpc = await this.connection(undefined, signal);
      try { const info = await rpc.describe(); return new Set([info.protocolName, ...(info.hostedProtocols ?? [])]); }
      finally { rpc.close(); }
    })().catch(error => { this.advertised = undefined; throw error; });
    return this.advertised;
  }
  async discover(signal?: AbortSignal, protocol: string = REPORTS_PROTOCOL): Promise<boolean> {
    const protocols = await this.protocols(signal);
    return protocols.has(protocol) || protocol === REPORTS_PROTOCOL && protocols.has('vgi.objects.v1') || protocol === 'vgi.schedules.v1' && protocols.has('vgi.schedules.v2') || protocol === 'vgi.reports.ownership.v1' && protocols.has('vgi.ownership.v1');
  }
  /** Optional additions to a protocol must be discovered by method, including on older workers. */
  async supports(method: Method, signal?: AbortSignal): Promise<boolean> {
    const { protocol, name } = methodConfig[method];
    if (!await this.discover(signal, protocol)) return false;
    let methods = this.advertisedMethods.get(protocol);
    if (!methods) {
      methods = (async () => {
        const rpc = await this.connection(protocol, signal);
        try { return new Set((await rpc.describe()).methods.map(m => m.name)); }
        finally { rpc.close(); }
      })().catch(error => { this.advertisedMethods.delete(protocol); throw error; });
      this.advertisedMethods.set(protocol, methods);
    }
    return (await methods).has(name);
  }
  async protocolFor(method: Method, signal?: AbortSignal): Promise<string> {
    const original = methodConfig[method].protocol;
    if (!['vgi.reports.v1', 'vgi.reports.ownership.v1', 'vgi.schedules.v1'].includes(original)) return original;
    const protocols = await this.protocols(signal);
    const preferred = original === 'vgi.reports.v1' ? 'vgi.objects.v1' : original === 'vgi.schedules.v1' ? 'vgi.schedules.v2' : 'vgi.ownership.v1';
    return protocols.has(preferred) ? preferred : original;
  }
  async canFindOwners(resourceKind: 'report' | 'folder', signal?: AbortSignal): Promise<boolean> {
    if (!await this.discover(signal, 'vgi.reports.ownership.v1')) return false;
    if (await this.protocolFor('find_owners', signal) !== 'vgi.ownership.v1') return true;
    const protocol = await this.protocolFor('get_report', signal);
    const kind = protocol === 'vgi.objects.v1' && resourceKind === 'report' ? 'object' : resourceKind;
    const info = await this.rawCall('ownership.get_ownership_info', {}, signal);
    return info.resources.some(r => r.protocol === protocol && r.resource_kind === kind);
  }
  async call<M extends Method>(method: M, input: Input<M>, signal?: AbortSignal, wireProtocol?: string): Promise<Output<M>> {
    const selected = wireProtocol ?? await this.protocolFor(method, signal);
    const original = methodConfig[method].protocol;
    if (selected === original) return this.rawCall(method, input, signal);
    let args: any = { ...input }, translated: string = method;
    if (selected === 'vgi.objects.v1') {
      const names: Record<string, string> = { get_report_service_info: 'get_objects_info', get_report: 'get_object', list_reports: 'list_objects', create_report: 'create_object', move_report: 'move_object', delete_report: 'delete_object' };
      translated = 'objects.' + (names[method] ?? method);
      if ('report_id' in args) { args.object_id = args.report_id; delete args.report_id; }
      if (method === 'create_report') args.object_kind = kindForFormat(args.envelope.body_format);
      return fromObject(await this.rawCall(translated as Method, args, signal));
    }
    if (selected === 'vgi.ownership.v1') {
      const protocol = await this.protocolFor('get_report', signal);
      return this.rawCall('ownership.find_owners', { ...args, protocol, resource_kind: protocol === 'vgi.objects.v1' && args.resource_kind === 'report' ? 'object' : args.resource_kind }, signal) as Promise<Output<M>>;
    }
    if (selected === 'vgi.schedules.v2') {
      translated = method.replace('schedules.', 'schedules2.');
      if (args.schedule) args.schedule = toScheduleV2(args.schedule);
      if ('report_id' in args) {
        // Use the service-qualified objects API for associated schedules.
        if (args.report_id) throw new Error('A schedule source filter requires both library URL and object ID.');
        delete args.report_id;
      }
      return fromScheduleV2(await this.rawCall(translated as Method, args, signal));
    }
    throw new Error('Unsupported protocol for this saved request.');
  }
  async listSchedulesForSource(url: string, id: string, signal?: AbortSignal) {
    if (await this.protocolFor('schedules.list_schedules', signal) === 'vgi.schedules.v2') {
      return fromScheduleV2(await this.rawCall('schedules2.list_schedules', { source: { service_url: serviceLocation(url), object_id: id }, action_kind: 'render_report' }, signal)) as Output<'schedules.list_schedules'>;
    }
    return (await this.rawCall('schedules.list_schedules', { report_id: id, action_kind: 'render_report' }, signal)).filter(s => Boolean(s.definition.action.render_report && serviceLocation(s.definition.action.render_report.report.service_url) === serviceLocation(url)));
  }
  private async rawCall<M extends Method>(method: M, input: Input<M>, signal?: AbortSignal): Promise<Output<M>> {
    const config = methodConfig[method];
    const params: Record<string, any> = { ...config.defaults, ...input };
    for (const [key, name] of Object.entries(config.structured)) if (params[key] != null) params[key] = encodeRecord(name, params[key]);
    const rpc = await this.connection(config.protocol, signal);
    try {
      if (!config.stream) {
        const result = decodeRecord((await rpc.call(config.name, params))?.result);
        if ('request_id' in params && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent(REPORT_LIBRARY_CHANGED, { detail: { url: this.url } }));
        }
        return result;
      }
      const stream = await rpc.stream(config.name, params);
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
