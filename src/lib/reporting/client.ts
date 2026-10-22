import { httpConnect } from '@query-farm/vgi-rpc/connect';
import { deserializeSchema, schema, serializeBatch, singleRowBatch } from '@query-farm/vgi-rpc/arrow';
import { tableFromIPC, type RecordBatch, type Schema } from '@query-farm/apache-arrow';
import { getAuthTokenForService } from '../auth';
import { connectionErrorMessage } from '../connection-errors';
import { identityDescription, methodConfig, recordSchemas, OBJECTS_PROTOCOL, OBJECT_SCHEDULES_PROTOCOL, OWNERSHIP_PROTOCOL, REPORTS_PROTOCOL, SCHEDULES_PROTOCOL, type ReportMethods, type ResourceContext } from './contracts.generated';
import { fromObject, fromScheduleV2, kindForFormat, toScheduleV2 } from './object-adapter';
import { REPORT_LIBRARY_CHANGED } from './navigation';
import { fetchWithCachedCapabilities } from './http-capabilities';

const OBJECT_OWNERSHIP_PROTOCOL = 'vgi.ownership.v1';
const preferredProtocols: Readonly<Record<string, string>> = {
  [REPORTS_PROTOCOL]: OBJECTS_PROTOCOL,
  [SCHEDULES_PROTOCOL]: OBJECT_SCHEDULES_PROTOCOL,
  [OWNERSHIP_PROTOCOL]: OBJECT_OWNERSHIP_PROTOCOL,
};

export type Method = keyof ReportMethods;
export type Input<M extends Method> = ReportMethods[M]['input'];
export type Output<M extends Method> = ReportMethods[M]['output'];
export const bytesFromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export function bytesToBase64(value: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < value.length; offset += 8192) result += String.fromCharCode(...value.subarray(offset, offset + 8192));
  return btoa(result);
}

// Generated from the Python protocol. Known schemas allow calls to older workers
// to return their real UNIMPLEMENTED error without per-method discovery.
const identityWireDescription = {
  ...identityDescription,
  hostedProtocols: [...identityDescription.hostedProtocols],
  methods: identityDescription.methods.map(method => ({
    ...method,
    // The RPC SDK types still name Arrow JS schemas; runtime uses its selected backend.
    paramsSchema: deserializeSchema(bytesFromBase64(method.paramsSchema)) as unknown as Schema,
    resultSchema: deserializeSchema(bytesFromBase64(method.resultSchema)) as unknown as Schema,
  })),
};

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
  private advertisedScope?: string;
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
      const ownService = target.origin === base.origin && (target.pathname === base.pathname || target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'));
      if (ownService && token) headers.set('Authorization', `Bearer ${token}`);
      try {
        const request: RequestInit = { ...init, headers, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
        return await (ownService ? fetchWithCachedCapabilities(transport, this.url, input, request) : transport(input, request));
      } catch (error) {
        const message = connectionErrorMessage(error, target.href);
        if (error instanceof Error && message !== error.message) throw new TypeError(message, { cause: error });
        throw error;
      }
    }) as typeof fetch;
    return httpConnect(this.url, { protocol, fetch: scopedFetch, description: protocol === identityDescription.protocolName ? identityWireDescription : undefined });
  }
  private async protocols(signal?: AbortSignal): Promise<Set<string>> {
    const scope = await this.recoveryScope();
    if (this.advertisedScope !== scope) { this.advertised = undefined; this.advertisedScope = scope; }
    if (!this.advertised) this.advertised = (async () => {
      const protocol = 'vgi_rpc.Reflection.v1';
      const rpc = await this.connection(protocol, signal);
      try {
        // Reflection has a fixed bootstrap contract. Asking what is hosted
        // needs no method description, including on catalog-only services.
        const response = await rpc.callRaw('list_protocols', {
          batch: singleRowBatch(schema([]), {}) as unknown as RecordBatch,
          metadata: new Map([
            ['vgi_rpc.method', 'list_protocols'],
            ['vgi_rpc.protocol', protocol],
            ['vgi_rpc.request_version', '1'],
          ]),
        });
        const info = decodeRecord(response?.batch.get(0)?.result);
        if (!Array.isArray(info.protocols) || info.protocols.some((entry: any) => typeof entry?.protocol !== 'string')) {
          throw new Error('The report worker returned an invalid protocol listing.');
        }
        return new Set<string>(info.protocols.map((entry: { protocol: string }) => entry.protocol));
      }
      finally { rpc.close(); }
    })().catch(error => { this.advertised = undefined; throw error; });
    return this.advertised;
  }
  async discover(signal?: AbortSignal, protocol: string = REPORTS_PROTOCOL): Promise<boolean> {
    const protocols = await this.protocols(signal);
    return protocols.has(protocol) || Object.hasOwn(preferredProtocols, protocol) && protocols.has(preferredProtocols[protocol]);
  }
  /** Unsupported metadata is optional; authentication and transport failures remain errors. */
  async identityInfo<M extends 'identity.get_current_identity' | 'identity.get_grant_policy'>(method: M, signal?: AbortSignal): Promise<Output<M> | null> {
    try { return await this.call(method, {}, signal); }
    catch (error) {
      if (errorCode(error) === 'UNIMPLEMENTED') return null;
      throw error;
    }
  }
  async protocolFor(method: Method, signal?: AbortSignal): Promise<string> {
    const original = methodConfig[method].protocol;
    if (!Object.hasOwn(preferredProtocols, original)) return original;
    const protocols = await this.protocols(signal);
    const preferred = preferredProtocols[original];
    return protocols.has(preferred) ? preferred : original;
  }
  async canFindOwners(resourceKind: 'report' | 'folder', signal?: AbortSignal): Promise<boolean> {
    if (!await this.discover(signal, OWNERSHIP_PROTOCOL)) return false;
    if (await this.protocolFor('find_owners', signal) !== OBJECT_OWNERSHIP_PROTOCOL) return true;
    const protocol = await this.protocolFor('get_report', signal);
    const kind = protocol === OBJECTS_PROTOCOL && resourceKind === 'report' ? 'object' : resourceKind;
    const info = await this.rawCall('ownership.get_ownership_info', {}, signal);
    return info.resources.some(r => r.protocol === protocol && r.resource_kind === kind);
  }
  async ownershipContext(resourceKind: 'report' | 'folder', resourceId: string, signal?: AbortSignal): Promise<ResourceContext> {
    const protocol = await this.protocolFor('get_report', signal);
    return { protocol, resource_kind: protocol === OBJECTS_PROTOCOL && resourceKind === 'report' ? 'object' : resourceKind,
      operation: 'transfer_ownership', resource_id: resourceId, parent_folder_id: null };
  }
  async call<M extends Method>(method: M, input: Input<M>, signal?: AbortSignal, wireProtocol?: string): Promise<Output<M>> {
    const selected = wireProtocol ?? await this.protocolFor(method, signal);
    const original = methodConfig[method].protocol;
    if (selected === original) return this.rawCall(method, input, signal);
    let args: any = { ...input }, translated: string = method;
    if (selected === OBJECTS_PROTOCOL) {
      const names: Record<string, string> = { get_report_service_info: 'get_objects_info', get_report: 'get_object', list_reports: 'list_objects', scan_reports: 'scan_objects', create_report: 'create_object', move_report: 'move_object', delete_report: 'delete_object' };
      translated = 'objects.' + (names[method] ?? method);
      if ('report_id' in args) { args.object_id = args.report_id; delete args.report_id; }
      if (method === 'create_report') args.object_kind = kindForFormat(args.envelope.body_format);
      return fromObject(await this.rawCall(translated as Method, args, signal));
    }
    if (selected === OBJECT_OWNERSHIP_PROTOCOL) {
      const protocol = await this.protocolFor('get_report', signal);
      return this.rawCall(('ownership.' + method) as Method, { ...args, protocol, resource_kind: protocol === OBJECTS_PROTOCOL && args.resource_kind === 'report' ? 'object' : args.resource_kind }, signal) as Promise<Output<M>>;
    }
    if (selected === OBJECT_SCHEDULES_PROTOCOL) {
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
  async listSchedulesForSource(url: string, id: string, signal?: AbortSignal, limit = 100n) {
    if (await this.protocolFor('schedules.list_schedules', signal) === OBJECT_SCHEDULES_PROTOCOL) {
      const records = fromScheduleV2(await this.rawCall('schedules2.list_schedules', { source: { service_url: serviceLocation(url), object_id: id }, action_kind: 'render_report', limit }, signal)) as Output<'schedules.list_schedules'>;
      return { records, limitReached: records.length >= Number(limit) };
    }
    // v1 has no service-qualified source filter. Inspect only this bounded set
    // before exposing a schedule as associated with the selected report.
    const summaries = await this.rawCall('schedules.list_schedules', { report_id: id, action_kind: 'render_report', limit }, signal);
    const matches = [];
    for (const summary of summaries) {
      const detail = await this.rawCall('schedules.get_schedule', { schedule_id: summary.schedule_id }, signal);
      const source = detail.definition.action.render_report?.report;
      if (source && serviceLocation(source.service_url) === serviceLocation(url) && source.report_id === id) matches.push(summary);
    }
    return { records: matches, limitReached: summaries.length >= Number(limit) };
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
          for (const key of config.int64Fields) if (result[key] != null) result[key] = BigInt(result[key]);
          return result;
        }));
        return rows as Output<M>;
      } finally { stream.close(); }
    } finally { rpc.close(); }
  }
}
