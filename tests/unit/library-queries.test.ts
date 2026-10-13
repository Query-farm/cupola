import { beforeEach, afterEach, expect, test } from 'bun:test';
import { openLibraryQuery, queryBinding, queryDraft, queryScope, saveQueryTabs, retainClosedQuery } from '../../src/lib/editor/library-queries';
import { bindDocument, documentDraftScope, documentIsDirty, markDocumentDeleted, portableBody, portableContext, resetDocumentBinding } from '../../src/lib/reporting/documents';
import { readEditorState, type EditorState } from '../../src/lib/editor/editor-store';
import { memoryStorage, record } from '../reporting/fixtures';
const originalStorage = globalThis.localStorage, originalWindow = globalThis.window;
beforeEach(() => { Object.assign(globalThis, { localStorage: memoryStorage(), window: new EventTarget() }); });
afterEach(() => { Object.assign(globalThis, { localStorage: originalStorage, window: originalWindow }); });
const response = (id = 'same-id', revision = 1) => ({ ...record(), report_id: id, revision_number: BigInt(revision), version: BigInt(revision), head_revision_id: `revision-${revision}`, revision_served: `revision-${revision}`, envelope: { ...record().envelope!, body_format: 'cupola.query/1', title: `Query ${id}`, data_sources: [] }, body: new TextEncoder().encode(JSON.stringify({ query: `SELECT ${revision}`, context: {} })) });
const request = (id = 'same-id', revision = 1, libraryUrl = 'https://worker.test', authScope = 'alice') => ({ record: response(id, revision), libraryUrl, authScope, pinned: false });
const empty = (): EditorState => ({ version: 1, activeId: 'scratch', docs: [{ id: 'scratch', name: 'Scratch', sql: 'SELECT 100', createdAt: 1, updatedAt: 1 }] });

test('deleting a library query preserves drafts and marks only the matching worker and account', () => {
  let state = openLibraryQuery(empty(), request(), 'workspace');
  state = openLibraryQuery(state, request('same-id', 1, 'https://second.test'), 'workspace');
  state = openLibraryQuery(state, request('same-id', 1, 'https://worker.test', 'bob'), 'workspace');
  state = openLibraryQuery(state, { ...request(), pinned: true }, 'workspace');
  state.docs[1].sql = 'SELECT 500 AS unsaved'; saveQueryTabs(state, 'workspace');
  markDocumentDeleted('https://worker.test', 'same-id', 'alice');
  expect(queryBinding(state.docs[1], 'workspace')?.deleted).toBe(true);
  expect(queryBinding(state.docs[4], 'workspace')?.deleted).toBe(true);
  expect(queryBinding(state.docs[1], 'workspace')?.record.allowed_actions).toEqual([]);
  expect(queryBinding(state.docs[2], 'workspace')?.deleted).toBeUndefined();
  expect(queryBinding(state.docs[3], 'workspace')?.deleted).toBeUndefined();
  expect(readEditorState(queryScope(state.docs[1], 'workspace'))?.docs[0].sql).toBe('SELECT 500 AS unsaved');
});

test('library queries join existing tabs, deduplicate, and keep workers, accounts and pinned revisions distinct', () => {
  let state = openLibraryQuery(empty(), request(), 'workspace');
  state = openLibraryQuery(state, request(), 'workspace');
  expect(state.docs).toHaveLength(2); expect(state.docs[0].sql).toBe('SELECT 100');
  state = openLibraryQuery(state, request('same-id', 1, 'https://second.test'), 'workspace');
  state = openLibraryQuery(state, request('same-id', 1, 'https://worker.test', 'bob'), 'workspace');
  state = openLibraryQuery(state, { ...request(), pinned: true }, 'workspace');
  expect(new Set(state.docs.map(d => d.id)).size).toBe(5);
  expect(queryBinding(state.docs.at(-1)!, 'workspace')?.readOnly).toBe(true);
});

test('clean tabs adopt fresh responses; dirty tabs keep edits and their original revision', () => {
  let state = openLibraryQuery(empty(), request(), 'workspace');
  state = openLibraryQuery(state, request('same-id', 2), 'workspace');
  expect(state.docs[1].sql).toBe('SELECT 2');
  state.docs[1] = { ...state.docs[1], name: 'Unsaved rename', sql: 'SELECT 200' };
  state = openLibraryQuery(state, request('same-id', 3), 'workspace');
  expect(state.docs[1].sql).toBe('SELECT 200'); expect(state.docs[1].name).toBe('Unsaved rename');
  expect(queryBinding(state.docs[1], 'workspace')?.record.revision_number).toBe(2n);
  expect(documentIsDirty('query', queryDraft(state.docs[1]), queryBinding(state.docs[1], 'workspace')!)).toBe(true);
  expect(readEditorState(queryScope(state.docs[1], 'workspace'))?.docs[0].sql).toBe('SELECT 200');
});

test('a query saved from an ordinary tab reopens that tab and retains dirty recovery after close', () => {
  let state = empty();
  const r = response(), binding = { url: 'https://worker.test', authScope: 'alice', record: r, original: portableBody(r), context: portableContext(portableBody(r)) };
  bindDocument('workspace', 'query', 'scratch', binding);
  state = openLibraryQuery(state, request(), 'workspace');
  expect(state.docs).toHaveLength(1); expect(state.activeId).toBe('scratch'); expect(state.docs[0].sql).toBe('SELECT 100');
  retainClosedQuery(state.docs[0], 'workspace');
  state = openLibraryQuery({ version: 1, activeId: null, docs: [] }, request(), 'workspace');
  expect(state.docs[0].sql).toBe('SELECT 100');
});

test('a details edit resetting the canonical binding updates the existing tab without duplicate ids', () => {
  let state = openLibraryQuery(empty(), request(), 'workspace');
  const scope = documentDraftScope('https://worker.test', 'same-id', null, 'alice');
  resetDocumentBinding(scope, 'query', 'same-id');
  state = openLibraryQuery(state, request('same-id', 2), 'workspace');
  expect(state.docs).toHaveLength(2); expect(state.docs[1].sql).toBe('SELECT 2');
  saveQueryTabs(state, 'workspace');
  expect(readEditorState(scope)?.docs[0].sql).toBe('SELECT 2');
});
