import type { EvidenceReport } from '../evidence/reports';
import type { RevisionMeta } from '../evidence/revisions';
import { encodeReport, type ReportMetadata } from './body';
import { errorCode, reportError, type ReportClient } from './client';
import type { ReportResult, ReportsInfo } from './contracts.generated';
import { MutationJournal, parseJournal, serializeJournal } from './journal';

export interface Draft { report: EvidenceReport; metadata: ReportMetadata; kind: 'edit' | 'agent' | 'restore' | 'import'; message: string }
export interface RecoveryDraft { base: ReportResult; draft: Draft; queued: Draft[]; journalId: string; updatedAt: number }
export interface SaveState { status: 'saved' | 'draft' | 'saving' | 'error' | 'conflict'; message: string; record: ReportResult }
const PREFIX = 'cupola.reporting.draft.v1:';
export function recoveryDrafts(scope: string, storage: Storage = localStorage): Array<{ key: string; value: RecoveryDraft }> {
  const rows = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (!key.startsWith(PREFIX + scope + ':')) continue;
    try { rows.push({ key, value: parseJournal(storage.getItem(key)!) as RecoveryDraft }); } catch { /* Do not delete a corrupt draft. */ }
  }
  return rows.sort((a, b) => b.value.updatedAt - a.value.updatedAt);
}

/** Serializes revision writes, keeping newer keystrokes independent of an in-flight request. */
export class SaveController {
  readonly journal: MutationJournal;
  readonly key: string;
  private draft: Draft;
  private queued: Draft[] = [];
  private running = false;
  private disposed = false;
  private savedContent: string;
  state: SaveState;
  onChange = (_state: SaveState) => {};
  constructor(readonly client: ReportClient, scope: string, record: ReportResult, report: EvidenceReport, private info: ReportsInfo, recovery?: { key: string; value: RecoveryDraft }, private storage: Storage = localStorage) {
    const id = recovery?.value.journalId ?? crypto.randomUUID();
    this.key = recovery?.key ?? PREFIX + scope + ':' + id;
    this.journal = new MutationJournal(client, scope, id, storage);
    this.draft = recovery?.value.draft ?? { report, metadata: { description: record.envelope?.description ?? '', tags: record.envelope?.tags ?? [], dataSources: record.envelope?.data_sources ?? [] }, kind: 'edit', message: '' };
    this.queued = recovery?.value.queued ?? [];
    this.state = { record: recovery?.value.base ?? record, status: recovery ? 'error' : 'saved', message: recovery ? 'Recovered draft. Review it, then retry saving.' : 'Saved to worker' };
    this.savedContent = this.content({ ...this.draft, report, metadata: { description: record.envelope?.description ?? '', tags: record.envelope?.tags ?? [], dataSources: record.envelope?.data_sources ?? [] } });
    if (recovery) this.savedContent = ''; // Recovery must reconcile its original precondition.
  }
  get current() { return this.draft; }
  get dirty() { return this.state.status !== 'saved'; }
  private content(draft: Draft): string {
    const encoded = encodeReport(draft.report, draft.metadata, this.info);
    return serializeJournal([encoded.envelope, encoded.body]);
  }
  private notify(status: SaveState['status'], message: string) {
    this.state = { ...this.state, status, message }; this.onChange(this.state);
  }
  private store() {
    const value: RecoveryDraft = { base: this.state.record, draft: this.draft, queued: this.queued, journalId: this.key.slice(this.key.lastIndexOf(':') + 1), updatedAt: Date.now() };
    this.storage.setItem(this.key, serializeJournal(value));
  }
  capture(report: EvidenceReport, metadata = this.draft.metadata): void {
    this.draft = { ...this.draft, report, metadata: { ...this.draft.metadata, ...metadata } };
    try {
      let unchanged = false;
      try { unchanged = this.content(this.draft) === this.savedContent; } catch { /* Preserve invalid drafts too. */ }
      if (!this.running && !this.queued.length && !this.journal.pending && unchanged) {
        this.storage.removeItem(this.key);
        if (this.state.status !== 'saved') this.notify('saved', 'Saved to worker');
        return;
      }
      this.store(); // Even a temporarily invalid edit must survive a reload.
      if (!['error', 'conflict', 'saving'].includes(this.state.status)) this.notify('draft', 'Draft kept in this browser');
    } catch (e) { this.notify('error', `${reportError(e)} Your changes are still in this tab; export them before closing it.`); }
  }
  stage(report: EvidenceReport, meta: RevisionMeta = { kind: 'edit' }): void {
    this.capture(report);
    const next: Draft = { ...this.draft, kind: meta.kind === 'baseline' ? 'edit' : meta.kind, message: meta.label ?? meta.agentSummaries?.join('\n') ?? '' };
    // Coalesce autosaves, but preserve explicit agent/restore boundaries.
    if ((this.queued.length > 1 || !this.running && !this.journal.pending) && next.kind === 'edit' && !next.message && this.queued.at(-1)?.kind === 'edit' && !this.queued.at(-1)?.message) this.queued[this.queued.length - 1] = next;
    else this.queued.push(next);
    try { this.store(); } catch (e) { this.notify('error', reportError(e)); return; }
    if (!['error', 'conflict'].includes(this.state.status)) void this.flush();
  }
  async retry(): Promise<void> {
    if (this.running) return;
    this.notify('draft', 'Retrying save…');
    try {
      if (!this.queued.length || this.content(this.queued.at(-1)!) !== this.content(this.draft)) this.queued.push(this.draft);
    } catch (error) { this.notify('error', reportError(error)); return; }
    await this.flush();
  }
  private async flush(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while ((this.journal.pending || this.queued.length) && !this.disposed) {
        this.notify('saving', 'Saving to worker…');
        let result: ReportResult;
        if (this.journal.pending) {
          const pending = this.journal.pending;
          result = await this.journal.retry();
          this.savedContent = serializeJournal([pending.input.envelope, pending.input.body]);
          // The queued item was durably retained until the request was acknowledged.
          this.queued.shift();
        } else {
          const next = this.queued[0];
          const content = this.content(next);
          if (content === this.savedContent) { this.queued.shift(); continue; }
          const { envelope, body } = encodeReport(next.report, next.metadata, this.info);
          this.store();
          result = await this.journal.run('commit_revision', { report_id: this.state.record.report_id, expected_revision_id: this.state.record.head_revision_id, envelope, body, kind: next.kind, message: next.message });
          this.savedContent = content;
          this.queued.shift();
        }
        this.state = { ...this.state, record: result };
        this.store(); // Keep newer keystrokes even if the tab closes before the debounce fires.
      }
      if (this.content(this.draft) === this.savedContent && !this.queued.length) {
        this.storage.removeItem(this.key); this.notify('saved', 'Saved to worker');
      } else this.notify('draft', 'Draft kept in this browser');
    } catch (error) {
      this.notify(errorCode(error) === 'ABORTED' ? 'conflict' : 'error', reportError(error));
    } finally { this.running = false; }
  }
  updateRecord(record: ReportResult) {
    if (record.head_revision_id !== this.state.record.head_revision_id) {
      this.notify('conflict', 'The report head changed. Reload it before editing; your draft is retained.');
      return;
    }
    this.state = { ...this.state, record }; this.onChange(this.state);
  }
  dispose() { this.disposed = true; this.onChange = () => {}; }
}
