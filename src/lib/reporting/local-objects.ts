import { parseJournal, serializeJournal } from './journal';
import { EVIDENCE_REPORTS_CHANGED } from '../evidence/reports';
import type { ReportEnvelope, ReportResult } from './contracts.generated';
import type { DocumentKind } from './documents';

export interface LocalObject { id: string; kind: DocumentKind; envelope: ReportEnvelope; body: Uint8Array; updatedAt: number }
const prefix = (scope: string) => `cupola.objects.local.v1:${encodeURIComponent(scope)}:`;
export function listLocalObjects(scope: string, storage: Storage = localStorage): LocalObject[] {
  const objects: LocalObject[] = [];
  for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(prefix(scope))) objects.push(parseJournal(storage.getItem(key)!)); }
  return objects;
}
export function saveLocalObject(scope: string, object: LocalObject, storage: Storage = localStorage) {
  storage.setItem(prefix(scope) + object.id, serializeJournal(object));
  if (typeof window !== 'undefined' && storage === window.localStorage) window.dispatchEvent(new Event(EVIDENCE_REPORTS_CHANGED));
}
export function deleteLocalObject(scope: string, id: string, storage: Storage = localStorage) {
  storage.removeItem(prefix(scope) + id);
  if (typeof window !== 'undefined' && storage === window.localStorage) window.dispatchEvent(new Event(EVIDENCE_REPORTS_CHANGED));
}
export function localObjectRecord(object: LocalObject): ReportResult {
  const actor = { id: 'local', kind: 'user' as const, display_name: 'On this device', email: null };
  return { report_id: object.id, object_kind: object.kind, version: 1n, folder_id: null, head_revision_id: String(object.updatedAt), published_revision_id: null,
    revision_served: String(object.updatedAt), revision_number: 1n, envelope: object.envelope, body: object.body, body_sha256: null, redacted: false,
    ownership: { owner_ref: { kind: 'principal', id: 'local', display_name: 'On this device' }, parent_owner_ref: null },
    created_at: object.updatedAt, updated_at: object.updatedAt, created_by: actor, updated_by: actor, allowed_actions: ['read', 'edit', 'move', 'delete'] } as ReportResult;
}
