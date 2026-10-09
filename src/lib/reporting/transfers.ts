import { deleteEvidenceReport, listEvidenceReports, reportScope, saveEvidenceReport, type EvidenceReport } from '../evidence/reports';
import { BODY_FORMAT, decodeReport, encodeReport } from './body';
import { ReportClient } from './client';
import type { ReportEnvelope, ReportRow } from './contracts.generated';
import { parseJournal, serializeJournal } from './journal';
import { localReportEntry, placeLocalReport } from './local-library';

export type TransferSource = { kind: 'local'; report: EvidenceReport } | { kind: 'worker'; url: string; record: ReportRow };
export interface TransferDestination { url: string | null; folderId: string | null; name: string }
export interface TransferJob {
  id: string; scope: string; createdAt: number; move: boolean; source: TransferSource; destination: TransferDestination;
  envelope: ReportEnvelope; body: Uint8Array; localReport?: EvidenceReport;
  sourceAuth?: string; destinationAuth?: string;
  copied?: { id: string; revision?: string }; phase: 'copy' | 'remove';
  localId: string; serviceUrl: string; workspaceId?: string;
}
export type ClientFactory = (url: string) => ReportClient;
const prefix = 'cupola.reporting.transfer.v1:';
const jobKey = (job: TransferJob) => prefix + encodeURIComponent(job.scope) + ':' + job.id;
export function transferJobs(scope: string, storage: Storage = localStorage): TransferJob[] {
  const jobs: TransferJob[] = [], start = prefix + encodeURIComponent(scope) + ':';
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(start)) jobs.push(parseJournal(storage.getItem(key)!));
  }
  return jobs;
}
export function forgetTransfer(job: TransferJob, storage: Storage = localStorage) { storage.removeItem(jobKey(job)); }
const persist = (job: TransferJob, storage: Storage) => storage.setItem(jobKey(job), serializeJournal(job));
const sameReport = (a: EvidenceReport, b: EvidenceReport) => JSON.stringify(a) === JSON.stringify(b);
const equalBytes = (a: Uint8Array | null, b: Uint8Array) => a?.length === b.length && a.every((byte, i) => byte === b[i]);

/** Freeze the definition and credentials' scopes before any write; never store bearer tokens. */
export async function prepareTransfer(source: TransferSource, destination: TransferDestination, move: boolean,
  context: { scope: string; serviceUrl: string; workspaceId?: string },
  client: ClientFactory = url => new ReportClient(url), storage: Storage = localStorage): Promise<TransferJob> {
  const job: TransferJob = { ...context, id: crypto.randomUUID(), localId: crypto.randomUUID(), createdAt: Date.now(),
    source, destination, move, phase: 'copy', envelope: null!, body: null! };
  if (source.kind === 'local') {
    const report = listEvidenceReports(reportScope(source.report), storage).find(r => r.id === source.report.id);
    if (!report || !sameReport(report, source.report)) throw new Error('The local report changed. Reopen the transfer with its latest version.');
    const metadata = localReportEntry(reportScope(report), report, storage).metadata ?? { description: '', tags: [] };
    if (destination.url) {
      const encoded = encodeReport(report, metadata);
      job.envelope = encoded.envelope; job.body = encoded.body;
    } else {
      // A local folder operation does not need to serialize HTTP attachments.
      // Local reports may use other transports, including Iroh.
      job.envelope = { title: report.title, description: metadata.description, tags: metadata.tags, body_format: BODY_FORMAT, data_sources: metadata.dataSources ?? [], parameters: [] };
      job.body = new Uint8Array();
    }
    job.localReport = report;
  } else {
    const sourceClient = client(source.url);
    job.sourceAuth = await sourceClient.recoveryScope();
    const record = await sourceClient.call('get_report', { report_id: source.record.report_id, revision_id: source.record.revision_served });
    if (record.version !== source.record.version) throw new Error('The source report changed. Reload it before transferring.');
    if (record.redacted || !record.envelope || record.body === null) throw new Error('This report has no readable content to transfer.');
    if (move && !record.allowed_actions.includes(destination.url === source.url ? 'move' : 'delete')) throw new Error('You can copy this report, but do not have permission to move it from this location.');
    if (move && destination.url !== source.url && record.revision_served !== record.head_revision_id) throw new Error('Open the current report before moving it to another location. A historical revision can be copied.');
    job.envelope = record.envelope; job.body = record.body;
    if (!destination.url) job.localReport = decodeReport(record, context.serviceUrl, context.workspaceId);
  }
  if (destination.url) {
    const target = client(destination.url);
    job.destinationAuth = await target.recoveryScope();
    const info = await target.call('get_report_service_info', {});
    const actions = destination.folderId ? (await target.call('get_folder', { folder_id: destination.folderId })).allowed_actions : info.root_allowed_actions;
    if (!info.writable || !actions.includes('create_report')) throw new Error('You cannot save reports in this destination. Choose another folder or On this device.');
    if (!info.body_formats.includes(job.envelope.body_format)) throw new Error('The destination does not accept this report format.');
    const max = info.limits.find(limit => limit.name === 'max_body_bytes')?.value;
    if (max != null && BigInt(job.body.length) > max) throw new Error('This report exceeds the destination’s size limit.');
  } else if (job.envelope.body_format !== BODY_FORMAT) throw new Error('Only Cupola reports can be saved in this browser. Download the original body instead.');
  persist(job, storage); // A storage failure must prevent dispatch.
  return job;
}

/** A cross-store move is copy, confirm, then CAS-delete. Each phase survives reload
 * and retries with its original ID; failure never silently starts another copy. */
export async function resumeTransfer(input: TransferJob, client: ClientFactory = url => new ReportClient(url), storage: Storage = localStorage): Promise<TransferJob> {
  const action = async () => {
    const raw = storage.getItem(jobKey(input));
    if (!raw) throw new Error('This transfer was already completed or discarded.');
    const job: TransferJob = parseJournal(raw);
    if (Date.now() - job.createdAt >= 24 * 60 * 60 * 1000) throw new Error('This transfer is outside the retry window. Check the destination; keep the original unless you have verified the copy.');
    const source = job.source.kind === 'worker' ? client(job.source.url) : null;
    const target = job.destination.url ? client(job.destination.url) : null;
    if (source && await source.recoveryScope() !== job.sourceAuth || target && await target.recoveryScope() !== job.destinationAuth) throw new Error('Return to the accounts that started this transfer before retrying.');
    if (job.move && job.source.kind === 'worker' && job.source.url === job.destination.url) {
      await source!.call('move_report', { request_id: job.id + '-move', report_id: job.source.record.report_id, expected_version: job.source.record.version, folder_id: job.destination.folderId });
      job.copied = { id: job.source.record.report_id }; forgetTransfer(job, storage); return job;
    }
    if (job.move && job.source.kind === 'local' && !target) {
      const original = job.source.report;
      const current = listEvidenceReports(reportScope(original), storage).find(r => r.id === original.id);
      if (!current || !sameReport(current, job.source.report)) throw new Error('The local report changed; it has not been moved.');
      placeLocalReport(reportScope(current), current.id, job.destination.folderId, undefined, storage);
      job.copied = { id: current.id }; forgetTransfer(job, storage); return job;
    }
    if (job.phase === 'copy') {
      if (target) {
        const copied = await target.call('create_report', { request_id: job.id + '-copy', envelope: job.envelope, body: job.body,
          folder_id: job.destination.folderId, message: 'Transferred report definition. Source history and publication are not transferred.' });
        job.copied = { id: copied.report_id, revision: copied.head_revision_id };
      } else {
        const existing = listEvidenceReports(job.scope, storage).find(r => r.id === job.localId);
        const next = { ...job.localReport!, id: job.localId, serviceUrl: job.serviceUrl, workspaceId: job.workspaceId, createdAt: job.createdAt };
        if (existing && JSON.stringify({ ...existing, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 })) throw new Error('The destination copy changed. The original has been kept.');
        placeLocalReport(job.scope, job.localId, job.destination.folderId, { description: job.envelope.description, tags: job.envelope.tags, dataSources: job.envelope.data_sources }, storage);
        if (!existing) saveEvidenceReport(next, storage);
        job.copied = { id: job.localId };
      }
      job.phase = 'remove'; persist(job, storage);
    }
    if (job.move) {
      if (target) {
        const copied = await target.call('get_report', { report_id: job.copied!.id, revision_id: job.copied!.revision });
        if (!equalBytes(copied.body, job.body) || copied.head_revision_id !== job.copied!.revision) throw new Error('The destination copy changed or is no longer readable. Check both locations before continuing.');
      } else {
        const copied = listEvidenceReports(job.scope, storage).find(r => r.id === job.copied!.id);
        const expected = { ...job.localReport!, id: job.localId, serviceUrl: job.serviceUrl, workspaceId: job.workspaceId, createdAt: job.createdAt };
        if (!copied || JSON.stringify({ ...copied, updatedAt: 0 }) !== JSON.stringify({ ...expected, updatedAt: 0 })) throw new Error('The local copy is missing or changed. The original has been kept.');
      }
      if (source && job.source.kind === 'worker') {
        await source.call('delete_report', { request_id: job.id + '-remove', report_id: job.source.record.report_id, expected_version: job.source.record.version });
      } else if (job.source.kind === 'local') {
        const original = job.source.report;
      const current = listEvidenceReports(reportScope(original), storage).find(r => r.id === original.id);
        if (current && !sameReport(current, job.source.report)) throw new Error('The original changed during the transfer. The copy was saved and the original kept.');
        if (current) deleteEvidenceReport(reportScope(current), current.id, storage);
      }
    }
    forgetTransfer(job, storage); return job;
  };
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(jobKey(input), action) : action();
}
