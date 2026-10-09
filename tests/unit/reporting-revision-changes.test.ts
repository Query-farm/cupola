import { describe, expect, test } from 'bun:test';
import { reportRevisionChanges } from '../../src/lib/reporting/revision-changes';
import { record, report } from '../reporting/fixtures';

const body = (document: unknown) => new TextEncoder().encode(JSON.stringify({ version: 1, document }));
describe('worker revision comparisons', () => {
  test('compares metadata, SQL and controls without discarding unknown document fields', () => {
    const before = record(), after = record({ ...report('New title'), source: '# Changed', setupSql: 'SELECT 2;' });
    after.envelope = { ...after.envelope!, description: 'New description', tags: ['quarterly'] };
    const doc = JSON.parse(new TextDecoder().decode(after.body!));
    doc.document.parameters = [{ key: 'threshold', defaultValue: 42 }]; doc.document.futureSetting = { enabled: true };
    after.body = body(doc.document);
    expect(reportRevisionChanges(before, after).fields.map(f => f.label)).toEqual(expect.arrayContaining(['Title', 'Description', 'Tags', 'Document', 'Setup SQL', 'Report parameters', 'futureSetting']));
  });
  test('JSON formatting and object key order do not invent report changes', () => {
    const before = record(), after = record();
    before.body = body({ source: 'same', appearance: { font: 'serif', color: 'red' } });
    after.body = new TextEncoder().encode(JSON.stringify({ document: { appearance: { color: 'red', font: 'serif' }, source: 'same' }, version: 1 }, null, 2));
    expect(reportRevisionChanges(before, after)).toEqual({ fields: [], encodingChanged: true });
    after.envelope = { ...after.envelope!, title: 'Renamed' };
    expect(reportRevisionChanges(before, after).fields.map(f => f.label)).toEqual(['Title']);
  });
  test('type changes, array ordering and unusual field names remain visible', () => {
    const before = record(), after = record();
    before.body = body(JSON.parse('{"value":1,"list":[1,2],"__proto__":"old"}'));
    after.body = body(JSON.parse('{"value":"1","list":[2,1],"__proto__":"new"}'));
    const changes = reportRevisionChanges(before, after).fields;
    expect(changes.find(f => f.label === 'value')).toMatchObject({ before: '1', after: '"1"' });
    expect(changes.map(f => f.label)).toEqual(['value', 'list', '__proto__']);
    before.body = body({}); after.body = body(JSON.parse('{"constructor":"new","__proto__":"new"}'));
    expect(reportRevisionChanges(before, after).fields.map(f => [f.before, f.after])).toEqual([['(not present)', '"new"'], ['(not present)', '"new"']]);
  });
  test('text and binary formats retain their content differences', () => {
    const before = record(), after = record();
    before.envelope!.body_format = after.envelope!.body_format = 'text/markdown';
    before.body = new TextEncoder().encode('Old\ntext'); after.body = new TextEncoder().encode('New\ntext');
    expect(reportRevisionChanges(before, after).fields[0]).toMatchObject({ label: 'Body', before: 'Old\ntext', after: 'New\ntext' });
    after.body = new Uint8Array([255, 254]);
    expect(reportRevisionChanges(before, after).fields[0].binary).toBe(true);
  });
  test('redaction, missing bodies and unrelated reports cannot become empty comparisons', () => {
    const before = record();
    expect(() => reportRevisionChanges(before, { ...record(), redacted: true })).toThrow('unavailable');
    expect(() => reportRevisionChanges(before, { ...record(), body: null })).toThrow('unavailable');
    expect(() => reportRevisionChanges(before, { ...record(), report_id: 'another' })).toThrow('same report');
  });
  test('resource ownership and timestamps are not changes to the report definition', () => {
    expect(reportRevisionChanges(record(), { ...record(), updated_at: 500, version: 2n, updated_by: { id: 'bob', display_name: 'Bob', email: null } })).toEqual({ fields: [], encodingChanged: false });
  });
});
