import type { ReportResult } from './contracts.generated';

export interface RevisionFieldChange { key: string; label: string; before: string; after: string; binary?: boolean }
export interface RevisionChanges { fields: RevisionFieldChange[]; encodingChanged: boolean }

const labels: Record<string, string> = {
  title: 'Title', description: 'Description', tags: 'Tags', body_format: 'Body format', data_sources: 'Data sources', parameters: 'Parameters',
  source: 'Document', setupSql: 'Setup SQL', appearance: 'Appearance', semanticDatasets: 'Datasets', pivots: 'Pivot views',
  drillPaths: 'Drill paths', requires: 'Required catalogs', version: 'Document version',
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Object property order is an encoding detail; array order and all values are preserved. */
const json = (value: unknown) => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item, 2);
const text = (value: unknown, quoteString = false): string => value === undefined ? '(not present)' : typeof value === 'string' && !quoteString ? value : json(value);
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
function utf8(body: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return null; }
}
function cupola(body: string | null): Record<string, unknown> | null {
  if (body === null) return null;
  try { const value: unknown = JSON.parse(body); return object(value) && value.version === 1 && object(value.document) ? value : null; }
  catch { return null; }
}

/** Compare the actual saved envelope and body, without executing or normalizing
 * through the editor (which could drop unknown fields from a future document). */
export function reportRevisionChanges(before: ReportResult, after: ReportResult): RevisionChanges {
  if (before.report_id !== after.report_id) throw new Error('Choose two revisions of the same report.');
  for (const record of [before, after]) if (record.redacted || !record.envelope || record.body === null) throw new Error('A selected revision has been redacted or its content is unavailable.');
  const fields: RevisionFieldChange[] = [];
  function compare(a: Record<string, unknown>, b: Record<string, unknown>, prefix: string, names = labels) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const oldValue = Object.hasOwn(a, key) ? a[key] : undefined, newValue = Object.hasOwn(b, key) ? b[key] : undefined;
      if (json(oldValue) === json(newValue)) continue;
      const changedType = typeof oldValue !== typeof newValue;
      fields.push({ key: `${prefix}.${key}`, label: Object.hasOwn(names, key) ? names[key] : key, before: text(oldValue, changedType), after: text(newValue, changedType) });
    }
  }
  compare({ ...before.envelope! }, { ...after.envelope! }, 'envelope');
  const changedBody = !equalBytes(before.body!, after.body!);
  const metadataCount = fields.length;
  if (changedBody) {
    const oldText = utf8(before.body!), newText = utf8(after.body!);
    const bothCupola = before.envelope!.body_format === 'cupola.evidence/1' && after.envelope!.body_format === 'cupola.evidence/1';
    const oldDocument = bothCupola ? cupola(oldText) : null, newDocument = bothCupola ? cupola(newText) : null;
    if (oldDocument && newDocument) {
      compare(oldDocument.document as Record<string, unknown>, newDocument.document as Record<string, unknown>, 'document', { ...labels, parameters: 'Report parameters' });
      const { document: _old, ...oldExtra } = oldDocument, { document: _new, ...newExtra } = newDocument;
      compare(oldExtra, newExtra, 'body', { version: 'Body version' });
    } else if (oldText !== null && newText !== null) fields.push({ key: 'body', label: 'Body', before: oldText, after: newText });
    else fields.push({ key: 'body', label: 'Body', binary: true,
      before: `${before.body!.length} bytes\nSHA-256: ${before.body_sha256 ?? 'unavailable'}`,
      after: `${after.body!.length} bytes\nSHA-256: ${after.body_sha256 ?? 'unavailable'}` });
  }
  return { fields, encodingChanged: changedBody && metadataCount === fields.length };
}
