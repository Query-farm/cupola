/**
 * Tests for the SQL editor's localStorage-backed document model.
 */
import { test, expect, describe, beforeEach } from "bun:test";

// Minimal localStorage shim for the bun environment.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const {
  loadEditorState,
  saveEditorState,
  addDoc,
  removeDoc,
  renameDoc,
  updateDocSql,
  setActive,
} = await import("../../src/lib/editor/editor-store");

describe("editor-store", () => {
  beforeEach(() => store.clear());

  test("seeds a single default doc when empty", () => {
    const s = loadEditorState();
    expect(s.docs.length).toBe(1);
    expect(s.docs[0].name).toBe("Query 1");
    expect(s.activeId).toBe(s.docs[0].id);
  });

  test("round-trips through save/load", () => {
    let s = loadEditorState();
    s = updateDocSql(s, s.activeId!, "SELECT 1");
    saveEditorState(s);
    const loaded = loadEditorState();
    expect(loaded.docs[0].sql).toBe("SELECT 1");
    expect(loaded.activeId).toBe(s.activeId);
  });

  test("addDoc appends and activates", () => {
    let s = loadEditorState();
    s = addDoc(s, "SELECT 2");
    expect(s.docs.length).toBe(2);
    expect(s.docs[1].sql).toBe("SELECT 2");
    expect(s.activeId).toBe(s.docs[1].id);
    expect(s.docs[1].name).toBe("Query 2");
  });

  test("removeDoc keeps at least one doc and fixes activeId", () => {
    let s = loadEditorState();
    s = addDoc(s, "b");
    const firstId = s.docs[0].id;
    const secondId = s.docs[1].id;
    s = removeDoc(s, secondId); // remove active
    expect(s.docs.length).toBe(1);
    expect(s.activeId).toBe(firstId);
    // Removing the last remaining doc re-seeds one.
    s = removeDoc(s, firstId);
    expect(s.docs.length).toBe(1);
    expect(s.activeId).toBe(s.docs[0].id);
  });

  test("renameDoc updates the name", () => {
    let s = loadEditorState();
    s = renameDoc(s, s.activeId!, "Sales");
    expect(s.docs[0].name).toBe("Sales");
  });

  test("setActive ignores unknown ids", () => {
    const s = loadEditorState();
    const same = setActive(s, "nope");
    expect(same.activeId).toBe(s.activeId);
  });

  test("heals a corrupt blob by seeding", () => {
    store.set("vgi-sql-editor-docs", "{not json");
    const s = loadEditorState();
    expect(s.docs.length).toBe(1);
  });

  test("nextName fills the smallest free slot", () => {
    let s = loadEditorState(); // Query 1
    s = addDoc(s); // Query 2
    s = removeDoc(s, s.docs[0].id); // remove Query 1, leaves Query 2
    s = addDoc(s); // should become Query 1 again
    const names = s.docs.map((d) => d.name).sort();
    expect(names).toEqual(["Query 1", "Query 2"]);
  });
});
