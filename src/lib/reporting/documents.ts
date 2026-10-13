import { localObjectRecord } from './local-objects';
import { appBase } from '../app-base';
import { engine, waitForEngineReady, type EngineConnection } from '../shell-bridge';
import { quoteIdent } from '../duckdb-query';
import { serviceLocation } from './client';
import { parseJournal, serializeJournal } from './journal';
import { getWorkspace } from '../workspace/store';
import { notebookSchema, newNotebook, type Notebook } from '../notebooks/model';
import type { EditorDoc } from '../editor/editor-store';
import type { CatalogData } from '../service';
import type { DataSource, ExecutionContext, ReportEnvelope, ReportResult } from './contracts.generated';
import { reportLink } from './body';
import { encodeWorkspaceToken } from '../workspace/codec';

export type DocumentKind = 'notebook' | 'query';
export interface DocumentConfiguration { sources: DataSource[]; context: ExecutionContext }
export interface DocumentBinding { localScope?: string; authScope?: string; pinnedRevision?: string; url: string; record: ReportResult; original: Record<string, any>; context: ExecutionContext; readOnly?: boolean; deleted?: boolean; configurationDraft?: DocumentConfiguration }
const key = (scope: string, kind: DocumentKind, id: string) => `cupola.objects.binding.v1:${JSON.stringify([scope, kind, id])}`;
export const DOCUMENT_BINDING_CHANGED = 'cupola:document-binding-changed';
export function documentBinding(scope: string, kind: DocumentKind, id: string): DocumentBinding | null {
  const raw = localStorage.getItem(key(scope, kind, id)); return raw ? parseJournal(raw) : null;
}
export function bindDocument(scope: string, kind: DocumentKind, id: string, binding: DocumentBinding) {
  localStorage.setItem(key(scope, kind, id), serializeJournal(binding));
  window.dispatchEvent(new Event(DOCUMENT_BINDING_CHANGED));
}
/** A confirmed deletion removes the saved object, never the user's recovery drafts. */
export function markDocumentDeleted(url: string, id: string, authScope: string) {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith('cupola.objects.binding.v1:')) continue;
    const binding: DocumentBinding = parseJournal(localStorage.getItem(key)!);
    if (binding.url === url && binding.record.report_id === id && binding.authScope === authScope) {
      localStorage.setItem(key, serializeJournal({ ...binding, deleted: true, readOnly: true, record: { ...binding.record, allowed_actions: [] } }));
    }
  }
  window.dispatchEvent(new Event(DOCUMENT_BINDING_CHANGED));
}
/** Compare editable content, excluding run results, timestamps and unknown extension fields. */
export function documentIsDirty(kind: DocumentKind, doc: Notebook | EditorDoc, binding: DocumentBinding): boolean {
  if (binding.configurationDraft && JSON.stringify(binding.configurationDraft) !== JSON.stringify({ sources: binding.record.envelope?.data_sources ?? [], context: portableContext(binding.original) })) return true;
  if (kind === 'query') return (doc as EditorDoc).sql !== binding.original.query || (doc as EditorDoc).name !== binding.record.envelope?.title;
  const original = decodeNotebook(binding.record, '', undefined, doc.id), current = doc as Notebook;
  return current.title !== original.title || JSON.stringify(current.cells) !== JSON.stringify(original.cells) || JSON.stringify(current.parameters ?? []) !== JSON.stringify(original.parameters ?? []);
}
export function effectiveDocumentBinding(binding: DocumentBinding): DocumentBinding {
  const draft = binding.configurationDraft;
  return draft ? { ...binding, context: draft.context, record: { ...binding.record, envelope: { ...binding.record.envelope!, data_sources: draft.sources } } } : binding;
}
export const documentConfigurationKey = (scope: string, kind: DocumentKind, id: string) => `cupola.objects.configuration:${JSON.stringify([scope, kind, id])}`;
/** Draft source choices affect Run before the document's first library save. */
export function documentExecutionBinding(scope: string, kind: DocumentKind, id: string): DocumentBinding | null {
  const binding = documentBinding(scope, kind, id);
  const raw = localStorage.getItem(documentConfigurationKey(scope, kind, id));
  const configuration: DocumentConfiguration | undefined = raw ? JSON.parse(raw) : undefined;
  if (binding) return effectiveDocumentBinding(configuration ? { ...binding, configurationDraft: configuration } : binding);
  if (!configuration) return null;
  const record = localObjectRecord({ id, kind, envelope: { title: 'Local draft', description: '', tags: [], body_format: `cupola.${kind}/1`, data_sources: configuration.sources, parameters: [] }, body: new TextEncoder().encode('{}'), updatedAt: 0 });
  return { url: 'local', record, original: {}, context: configuration.context };
}
export const documentSaveIntentKey = (scope: string, kind: DocumentKind, id: string) => `cupola.objects.save-intent:${JSON.stringify([scope, kind, id])}`;
export function portableBody(record: ReportResult): Record<string, any> {
  if (record.redacted || !record.envelope || !record.body) throw new Error('This revision is unavailable.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.body));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid document body.');
  return value;
}
export function portableContext(body: Record<string, any>): ExecutionContext {
  const value = body.context ?? {};
  return { default_source_alias: value.default_source_alias ?? null, default_schema: value.default_schema ?? null };
}
export function captureContext(): ExecutionContext {
  const alias = engine.defaultCatalog.alias === 'memory' ? null : engine.defaultCatalog.alias;
  return { default_source_alias: alias, default_schema: alias ? engine.defaultCatalog.schema : null };
}
export function captureSources(catalogs: readonly CatalogData[], workspaceId?: string): DataSource[] {
  const workspace = workspaceId ? getWorkspace(workspaceId) : null;
  return catalogs.map(c => ({ ...c, sourceUrl: c.sourceUrl ?? engine.catalogStatuses.get(c.catalogName)?.url })).filter(c => c.sourceUrl).map(c => {
    const saved = workspace?.catalogs.find(s => s.alias === c.catalogName && serviceLocation(s.url) === serviceLocation(c.sourceUrl!));
    return { alias: c.catalogName, attachment_id: saved?.id ?? c.catalogName, location: serviceLocation(c.sourceUrl!), catalog_name: c.serverCatalogName ?? c.catalogName, label: '', required: c.catalogName === captureContext().default_source_alias };
  });
}
export function encodeDocument(kind: DocumentKind, doc: Notebook | EditorDoc, catalogs: readonly CatalogData[], workspaceId?: string, binding?: DocumentBinding | null): { envelope: ReportEnvelope; body: Uint8Array } {
  const previous = binding?.original ?? {};
  const context = { ...previous.context, ...(binding?.configurationDraft?.context ?? binding?.context ?? captureContext()) };
  const sources = binding?.configurationDraft?.sources ?? binding?.record.envelope?.data_sources ?? captureSources(catalogs, workspaceId);
  if (context.default_source_alias && !sources.some(s => s.alias === context.default_source_alias)) throw new Error('The default catalog is not available. Connect it before saving this document.');
  const envelope: ReportEnvelope = { title: 'title' in doc ? doc.title : doc.name, description: binding?.record.envelope?.description ?? '', tags: binding?.record.envelope?.tags ?? [], body_format: `cupola.${kind}/1`, data_sources: sources, parameters: binding?.record.envelope?.parameters ?? [] };
  let body: Record<string, any>;
  if (kind === 'query') {
    body = { ...previous, query: (doc as EditorDoc).sql, setup_sql: previous.setup_sql ?? '', dialect: previous.dialect ?? 'duckdb', context };
  } else {
    const notebook = doc as Notebook;
    envelope.parameters = (notebook.parameters ?? []).map(p => ({ key: p.key, label: p.label, type: p.type, required: p.required, default_json: JSON.stringify(p.defaultValue), options: (p.choices ?? []).map(v => ({ label: v, value_json: JSON.stringify(v) })) }));
    const oldCells = new Map((previous.cells ?? []).map((c: any) => [c.id, c]));
    body = { ...previous, version: 1, cells: notebook.cells.map(c => {
      const old = oldCells.get(c.id) as any;
      return { ...old, ...c, ...(c.type === 'sql' ? { charts: c.charts.map(chart => ({ ...old?.charts?.find((v: any) => v.id === chart.id), ...chart })) } : {}) };
    }),
      parameters: (notebook.parameters ?? []).map(p => ({ ...previous.parameters?.find((old: any) => old.key === p.key), id: p.id, key: p.key })), context };
  }
  for (const field of ['workspaceId', 'serviceUrl', 'values', 'credentials', 'results', 'id', 'createdAt', 'updatedAt', 'title']) delete body[field];
  return { envelope, body: new TextEncoder().encode(JSON.stringify(body)) };
}
export function decodeNotebook(record: ReportResult, serviceUrl: string, workspaceId: string | undefined, id: string): Notebook {
  const body = portableBody(record);
  if (record.envelope?.body_format !== 'cupola.notebook/1' || body.version !== 1) throw new Error('This notebook format is not supported. Download its original body.');
  // Select known fields for the editor; the original body is retained for lossless saves.
  const fields = ['id', 'type', 'title', 'source', 'collapsed', 'codeHidden', 'outputHidden', 'charts', 'outputHeight'];
  const chartFields = ['id', 'title', 'type', 'x', 'y', 'color', 'xType', 'sort', 'xTitle', 'yTitle', 'yFormat'];
  const cells = (body.cells ?? []).map((c: any) => ({ ...Object.fromEntries(fields.filter(k => k in c).map(k => [k, c[k]])),
    ...(c.type === 'sql' ? { charts: (c.charts ?? []).map((chart: any) => Object.fromEntries(chartFields.filter(k => k in chart).map(k => [k, chart[k]]))) } : {}) }));
  return notebookSchema.parse({ version: 1, id, title: record.envelope.title, serviceUrl, ...(workspaceId ? { workspaceId } : {}), cells,
    parameters: record.envelope.parameters.map(p => ({ id: body.parameters?.find((v: any) => v.key === p.key)?.id ?? p.key, key: p.key, label: p.label, type: p.type,
      required: p.required, defaultValue: JSON.parse(p.default_json), ...(p.type === 'select' ? { choices: p.options.map(o => JSON.parse(o.value_json)) } : {}) })),
    createdAt: record.created_at, updatedAt: record.updated_at });
}
export function assertDocumentSources(sources: DataSource[], context: ExecutionContext) {
  for (const source of sources) {
    const connected = engine.catalogStatuses.get(source.alias);
    if (!source.required && source.alias !== context.default_source_alias && (!connected || connected.state !== 'attached')) continue;
    if (!connected || connected.state !== 'attached' || serviceLocation(connected.url) !== serviceLocation(source.location) || connected.catalogName !== source.catalog_name)
      throw new Error(`Connect ${source.catalog_name} from ${source.location} as “${source.alias}” before running this document. Its source will not be replaced with another catalog.`);
  }
  if (context.default_source_alias && !sources.some(s => s.alias === context.default_source_alias)) throw new Error('The saved default catalog is not declared by this document.');
}
export async function openDocumentConnection(binding: Pick<DocumentBinding, 'context' | 'record' | 'original'>): Promise<EngineConnection> {
  await waitForEngineReady();
  assertDocumentSources(binding.record.envelope?.data_sources ?? [], binding.context);
  if (!engine.openConnection) throw new Error('Isolated query connections are unavailable.');
  const connection = await engine.openConnection();
  try {
    const { default_source_alias: alias, default_schema: schema } = binding.context;
    const use = await connection.query(`USE ${quoteIdent(alias ?? 'memory')}.${quoteIdent(schema ?? 'main')}`);
    if (!use.ok) throw new Error(use.error);
    if (binding.original.setup_sql) { const setup = await connection.query(binding.original.setup_sql); if (!setup.ok) throw new Error(setup.error); }
    return connection;
  } catch (e) { await connection.close(); throw e; }
}
export async function documentLink(binding: DocumentBinding): Promise<string> {
  const url = new URL(reportLink(binding.url, binding.record.report_id, binding.pinnedRevision));
  url.pathname = `${(appBase ?? "/").replace(/\/$/, "")}/reports`;
  const sources = binding.record.envelope?.data_sources ?? [];
  if (sources.length) {
    const token = await encodeWorkspaceToken({ format: 'cupola-workspaces', version: 1, workspaces: [{
      catalogs: sources.map(s => ({ id: s.attachment_id, alias: s.alias, url: s.location, catalogName: s.catalog_name })),
      defaultCatalogId: sources.find(s => s.alias === binding.context.default_source_alias)?.attachment_id ?? null,
      defaultSchema: binding.context.default_schema,
    }] });
    url.searchParams.delete('service'); url.searchParams.delete('local_ws'); url.hash = `ws=${token}`;
  }
  return url.href;
}

/** After an explicit restore/details edit, keep the old recovery state and adopt the acknowledged revision. */
export const documentDraftScope = (url: string, id: string, revision: string | null, authScope?: string) => `cupola.saved-object:${JSON.stringify([url, authScope ?? null, id, revision ?? 'head'])}`;
export function resetDocumentDraft(url: string, id: string, kind: DocumentKind, authScope?: string) {
  const scope = documentDraftScope(url, id, null, authScope);
  resetDocumentBinding(scope, kind, id);
}
export function resetDocumentBinding(scope: string, kind: DocumentKind, id: string) {
  const bindingKey = key(scope, kind, id), old = localStorage.getItem(bindingKey);
  if (old) {
    // Retain both binding and editor storage before replacing the draft on reopen.
    const entries: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.includes(scope) || k.includes(encodeURIComponent(scope))) entries[k] = localStorage.getItem(k)!; }
    localStorage.setItem(`cupola.objects.recovery.v1:${Date.now()}:${id}`, JSON.stringify(entries));
    localStorage.removeItem(bindingKey);
    localStorage.removeItem(documentConfigurationKey(scope, kind, id));
  }
}

export function documentSessionKey(binding: DocumentBinding): string {
  return JSON.stringify([binding.record.envelope?.data_sources ?? [], binding.context, binding.original.setup_sql ?? '']);
}

/** A query tab keeps temporary tables and USE state until closed or reset. */
export class DocumentQuerySession {
  private pending?: Promise<EngineConnection>;
  private configuration?: string;
  private closed = false;
  private closing?: Promise<void>;
  async query(binding: DocumentBinding, sql: string, options?: Parameters<EngineConnection['query']>[1]) {
    if (this.closed) throw new Error('This query session is closed.');
    // Recheck identities on every run, including after disconnect/reconnect.
    assertDocumentSources(binding.record.envelope?.data_sources ?? [], binding.context);
    const configuration = documentSessionKey(binding);
    if (this.pending && configuration !== this.configuration) { const old = this.pending; this.pending = undefined; await old.then(c => c.close(), () => {}); }
    if (this.closed) throw new Error('This query session is closed.');
    options?.signal?.throwIfAborted();
    if (!this.pending) { this.configuration = configuration; this.pending = openDocumentConnection(binding); }
    const pending = this.pending;
    let connection: EngineConnection;
    try { connection = await pending; } catch (error) { if (this.pending === pending) this.pending = undefined; throw error; }
    if (this.closed) throw new Error('This query session is closed.');
    options?.signal?.throwIfAborted();
    return connection.query(sql, options);
  }
  close(): Promise<void> { this.closed = true; return this.closing ??= this.pending?.then(c => c.close(), () => {}) ?? Promise.resolve(); }
}

export function newLibraryDocument(kind: DocumentKind, serviceUrl: string, workspaceId: string | undefined, catalogs: readonly CatalogData[]) {
  const doc = kind === 'notebook' ? newNotebook(serviceUrl, workspaceId) : { id: crypto.randomUUID(), name: 'Untitled query', sql: '', createdAt: Date.now(), updatedAt: Date.now() };
  return { id: doc.id, kind, ...encodeDocument(kind, doc, catalogs, workspaceId), updatedAt: Date.now() };
}
