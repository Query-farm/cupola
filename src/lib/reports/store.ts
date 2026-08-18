import type { ReportDocumentV1, StoredReport } from "./types";
import { cloneReport } from "./types";
import { validateReport } from "./validation";

const DB_NAME = "cupola-reports";
const DB_VERSION = 1;
const STORE = "reports";
const MAX_REVISIONS = 20;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "document.id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function listReports(): Promise<ReportDocumentV1[]> {
  if (typeof indexedDB === "undefined") return [];
  const records = await transaction<StoredReport[]>("readonly", (store) => store.getAll());
  return records.map((r) => r.document).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getStoredReport(id: string): Promise<StoredReport | null> {
  if (typeof indexedDB === "undefined") return null;
  return (await transaction<StoredReport | undefined>("readonly", (store) => store.get(id))) ?? null;
}

export async function saveReport(input: ReportDocumentV1): Promise<ReportDocumentV1> {
  const errors = validateReport(input);
  if (errors.length) throw new Error(errors.join("\n"));
  const existing = await getStoredReport(input.id);
  const document = cloneReport(input);
  document.updatedAt = Date.now();
  document.revision = existing ? Math.max(existing.document.revision + 1, input.revision) : input.revision;
  const revisions = existing
    ? [...existing.revisions, cloneReport(existing.document)].slice(-MAX_REVISIONS)
    : [];
  await transaction<IDBValidKey>("readwrite", (store) => store.put({ document, revisions } satisfies StoredReport));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cupola:reports-changed"));
  return document;
}

export async function deleteReport(id: string): Promise<void> {
  await transaction<undefined>("readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cupola:reports-changed"));
}

export async function restoreReportRevision(id: string, revision: number): Promise<ReportDocumentV1> {
  const stored = await getStoredReport(id);
  const found = stored?.revisions.find((r) => r.revision === revision);
  if (!found) throw new Error("Report revision not found.");
  return saveReport({ ...cloneReport(found), revision: stored!.document.revision + 1 });
}

export function exportReportJson(report: ReportDocumentV1): string {
  return JSON.stringify(report, null, 2);
}

export function importReportJson(json: string): ReportDocumentV1 {
  const parsed = JSON.parse(json) as ReportDocumentV1;
  const errors = validateReport(parsed);
  if (errors.length) throw new Error(errors.join("\n"));
  return parsed;
}
