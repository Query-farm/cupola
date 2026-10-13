import { appBase } from '../app-base';
import { engine, waitForEngineReady, type EngineConnection } from '../shell-bridge';
import { quoteIdent } from '../duckdb-query';
import { serviceLocation } from './client';
import { parseJournal, serializeJournal } from './journal';
import { getWorkspace } from '../workspace/store';
import { notebookSchema, type Notebook } from '../notebooks/model';
import type { EditorDoc } from '../editor/editor-store';
import type { CatalogData } from '../service';
import type { DataSource, ExecutionContext, ReportEnvelope, ReportResult } from './contracts.generated';
import { reportLink } from './body';
import { encodeWorkspaceToken } from '../workspace/codec';

export type DocumentKind = 'notebook' | 'query';
export interface DocumentBinding { localScope?: string; url: string; record: ReportResult; original: Record<string, any>; context: ExecutionContext; readOnly?: boolean }
const key = (scope: string, kind: DocumentKind, id: string) => `cupola.objects.binding.v1:${JSON.stringify([scope, kind, id])}`;
export const DOCUMENT_BINDING_CHANGED = 'cupola:document-binding-changed';
export function documentBinding(scope: string, kind: DocumentKind, id: string): DocumentBinding | null {
  const raw = localStorage.getItem(key(scope, kind, id)); return raw ? parseJournal(raw) : null;
}
export function bindDocument(scope: string, kind: DocumentKind, id: string, binding: DocumentBinding) {
  localStorage.setItem(key(scope, kind, id), serializeJournal(binding));
  window.dispatchEvent(new Event(DOCUMENT_BINDING_CHANGED));
}
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
    return { alias: c.catalogName, attachment_id: saved?.id ?? c.catalogName, location: serviceLocation(c.sourceUrl!), catalog_name: c.serverCatalogName ?? c.catalogName, label: '', required: true };
  });
}
export function encodeDocument(kind: DocumentKind, doc: Notebook | EditorDoc, catalogs: readonly CatalogData[], workspaceId?: string, binding?: DocumentBinding | null): { envelope: ReportEnvelope; body: Uint8Array } {
  const previous = binding?.original ?? {};
  const context = { ...previous.context, ...(binding?.context ?? captureContext()) };
  const sources = binding?.record.envelope?.data_sources ?? captureSources(catalogs, workspaceId);
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
  for (const source of sources.filter(s => s.required || s.alias === context.default_source_alias)) {
    const connected = engine.catalogStatuses.get(source.alias);
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
  const url = new URL(reportLink(binding.url, binding.record.report_id));
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
  const bindingKey = key(scope, kind, id), old = localStorage.getItem(bindingKey);
  if (old) {
    // Retain both binding and editor storage before replacing the draft on reopen.
    const entries: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.includes(scope) || k.includes(encodeURIComponent(scope))) entries[k] = localStorage.getItem(k)!; }
    localStorage.setItem(`cupola.objects.recovery.v1:${Date.now()}:${id}`, JSON.stringify(entries));
    localStorage.removeItem(bindingKey);
  }
}
