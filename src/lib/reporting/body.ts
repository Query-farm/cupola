import { validateEvidenceReport, titled, type EvidenceReport } from '../evidence/reports';
import { serviceLocation } from './client';
import type { DataSource, ParameterSpec, ReportEnvelope, ReportResult, ReportsInfo } from './contracts.generated';

export const BODY_FORMAT = 'cupola.evidence/1';
export interface ReportMetadata { description: string; tags: string[]; dataSources?: DataSource[] }
export interface EncodedReport { envelope: ReportEnvelope; body: Uint8Array; localControls: string[] }

/** Cupola-only controls stay losslessly in the opaque body. Public parameters must have exactly
 * the protocol's semantics; query-driven choices and inclusive date ranges do not. */
export function publicParameters(report: EvidenceReport): { parameters: ParameterSpec[]; localControls: string[] } {
  const parameters: ParameterSpec[] = [], localControls: string[] = [];
  for (const p of report.parameters) {
    const selection = p.type === 'select' || p.type === 'multi_select';
    if (p.type === 'date_range' || selection && (p.options?.kind !== 'static' || p.allowAll || p.defaultMode && p.defaultMode !== 'value')) {
      localControls.push(p.label); continue;
    }
    parameters.push({ key: p.key, label: p.label, type: p.type, required: p.required,
      default_json: JSON.stringify(p.defaultValue ?? null),
      options: selection && p.options?.kind === 'static' ? p.options.values.map(o => ({ label: o.label, value_json: JSON.stringify(o.value) })) : [],
    });
  }
  return { parameters, localControls };
}

export function encodeReport(input: EvidenceReport, metadata: ReportMetadata, info?: ReportsInfo): EncodedReport {
  const report = validateEvidenceReport(titled(input));
  const { id: _id, workspaceId: _workspace, serviceUrl: _service, createdAt: _created, updatedAt: _updated, values: _values, title: _title, ...document } = report;
  const sources = (report.requires ?? []).map(r => {
    const location = serviceLocation(r.url);
    const matches = metadata.dataSources?.filter(s => s.location === location && s.catalog_name === r.catalogName) ?? [];
    const previous = matches.find(s => s.alias === r.alias) ?? (matches.length === 1 ? matches[0] : undefined);
    // An alias rebind must not destroy the attachment identity or worker-supplied metadata.
    return previous ? { ...previous, alias: r.alias } : { alias: r.alias, attachment_id: r.alias, location, catalog_name: r.catalogName, label: '', required: true };
  });
  const { parameters, localControls } = publicParameters(report);
  const envelope: ReportEnvelope = { title: report.title, description: metadata.description, tags: [...new Set(metadata.tags)], body_format: BODY_FORMAT, data_sources: sources, parameters };
  // View parameter values, local workspace IDs and credentials never become shared report state.
  const body = new TextEncoder().encode(JSON.stringify({ version: 1, document }));
  if (info && !info.body_formats.includes(BODY_FORMAT)) throw new Error('This worker does not accept Cupola reports.');
  const max = info?.limits.find(l => l.name === 'max_body_bytes')?.value;
  if (max != null && BigInt(body.length) > max) throw new Error(`This report exceeds the worker's ${max.toString()} byte limit. Export a copy before reducing it.`);
  return { envelope, body, localControls };
}

export function decodeReport(result: ReportResult, serviceUrl: string, workspaceId?: string): EvidenceReport {
  if (result.redacted || !result.envelope || result.body === null) throw new Error('This revision has been redacted. Its content is unavailable.');
  if (result.envelope.body_format !== BODY_FORMAT) throw new Error(`Cupola cannot edit ${result.envelope.body_format} reports. You can download the original body.`);
  let body: any;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.body)); }
  catch { throw new Error('This report does not contain valid Cupola JSON. Download the original body to inspect it.'); }
  if (body.version !== 1 || !body.document || typeof body.document !== 'object') throw new Error('This Cupola document version is not supported.');
  const report = validateEvidenceReport({ ...body.document, version: 1, id: result.report_id, title: result.envelope.title,
    serviceUrl, workspaceId, createdAt: result.created_at, updatedAt: result.updated_at, values: {},
    requires: result.envelope.data_sources.map(s => ({ alias: s.alias, url: s.location, catalogName: s.catalog_name })),
  });
  return report;
}

export function reportLink(serviceUrl: string, reportId?: string, revisionId?: string): string {
  const url = new URL(window.location.href);
  // A portable link resolves without the sender's browser-local workspace or OAuth fragment.
  url.search = ''; url.hash = '';
  url.pathname = url.pathname.replace(/\/(?:evidence|reports)(?:\/.*)?$/, '/reports');
  url.searchParams.set('service', serviceLocation(serviceUrl));
  url.searchParams.set('report_service', serviceLocation(serviceUrl));
  if (reportId) url.searchParams.set('report_id', reportId);
  if (revisionId) url.searchParams.set('report_revision', revisionId);
  return url.href;
}
