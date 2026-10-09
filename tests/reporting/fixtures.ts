import type { EvidenceReport } from '../../src/lib/evidence/reports';
import type { ReportResult, ReportsInfo } from '../../src/lib/reporting/contracts.generated';
import { encodeReport } from '../../src/lib/reporting/body';
export const report = (title = 'Finance overview'): EvidenceReport => ({ version: 1, id: 'local-report', title, source: '# Finance overview\n\n```sql numbers\nSELECT 42 AS value\n```\n\n{% table data="numbers" /%}', setupSql: '', serviceUrl: 'http://127.0.0.1:9009', createdAt: 1, updatedAt: 1, values: {}, parameters: [] });
export const info: ReportsInfo = { protocol_version: '1.0.0', display_name: 'Test', writable: true, limits: [], body_formats: ['cupola.evidence/1'], root_allowed_actions: ['read', 'create_report', 'create_folder'] };
export function record(input = report()): ReportResult {
  const { envelope, body } = encodeReport(input, { description: '', tags: [] });
  return { envelope, body, report_id: 'report', folder_id: null, version: 1n, head_revision_id: 'head', published_revision_id: null, revision_served: 'head', revision_number: 1n, body_sha256: 'hash', redacted: false, created_at: 1, updated_at: 1, created_by: { id: 'alice', display_name: 'Alice', email: null }, updated_by: { id: 'alice', display_name: 'Alice', email: null }, ownership: { owner_ref: { kind: 'principal', id: 'alice', display_name: 'Alice' }, parent_owner_ref: { kind: 'workspace', id: 'library', display_name: 'Library' } }, allowed_actions: ['read', 'edit', 'publish', 'redact', 'move', 'delete', 'transfer_ownership'] };
}
export function memoryStorage(): Storage {
  const records = new Map<string, string>();
  return { get length() { return records.size; }, key: i => [...records.keys()][i] ?? null, getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); }, removeItem: key => { records.delete(key); }, clear: () => records.clear() };
}
import type { EvidenceParameter } from '../../src/lib/evidence/reports';

export const nativeOnlyParameters: EvidenceParameter[] = [
  { id: 'empty', key: 'empty', label: 'Empty choices', type: 'select', required: false, defaultValue: null, options: { kind: 'static', values: [] } },
  { id: 'mixed', key: 'mixed', label: 'Mixed choices', type: 'select', required: false, defaultValue: 'one', options: { kind: 'static', values: [{ label: 'One', value: 'one' }, { label: 'Two', value: 2 }] } },
  { id: 'stale', key: 'stale', label: 'Stale default', type: 'select', required: false, defaultValue: 'removed', options: { kind: 'static', values: [{ label: 'Current', value: 'current' }] } },
  { id: 'duplicate', key: 'duplicate', label: 'Duplicate choices', type: 'multi_select', required: false, defaultValue: [], options: { kind: 'static', values: [{ label: 'A', value: 1 }, { label: 'B', value: 1 }] } },
  { id: 'blank_date', key: 'blank_date', label: 'Blank date', type: 'date', required: false, defaultValue: '' },
];
