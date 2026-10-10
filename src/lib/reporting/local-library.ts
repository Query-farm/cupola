import { EVIDENCE_REPORTS_CHANGED, listEvidenceReports, type EvidenceReport } from '../evidence/reports';
import type { ReportMetadata } from './body';

export interface LocalFolder { id: string; name: string; parentId: string | null }
interface LocalEntry { folderId: string | null; metadata?: ReportMetadata }
interface LocalLibrary { folders: LocalFolder[]; entries: Record<string, LocalEntry> }
const key = (scope: string) => `cupola.reporting.local-library.v1:${encodeURIComponent(scope)}`;
export function localLibrary(scope: string, storage: Storage = localStorage): LocalLibrary {
  const raw = storage.getItem(key(scope));
  return raw ? JSON.parse(raw) : { folders: [], entries: {} };
}
function write(scope: string, library: LocalLibrary, storage: Storage) {
  storage.setItem(key(scope), JSON.stringify(library));
  if (typeof window !== 'undefined' && storage === window.localStorage) window.dispatchEvent(new Event(EVIDENCE_REPORTS_CHANGED));
}
export function localFolderPath(id: string | null, folders: LocalFolder[]): string {
  const parts: string[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = folders.find(f => f.id === id);
    if (!folder) break;
    parts.unshift(folder.name); id = folder.parentId;
  }
  return parts.join(' / ');
}
export function createLocalFolder(scope: string, name: string, parentId: string | null, storage: Storage = localStorage): LocalFolder {
  const library = localLibrary(scope, storage);
  name = name.trim().normalize('NFC');
  if (!name || name.includes('/') || name.length > 255) throw new Error('Use a folder name of 1–255 characters without a slash.');
  if (parentId && !library.folders.some(f => f.id === parentId)) throw new Error('The destination folder no longer exists.');
  if (library.folders.some(f => f.parentId === parentId && f.name === name)) throw new Error('A folder with this name already exists here.');
  const folder = { id: crypto.randomUUID(), name, parentId };
  write(scope, { ...library, folders: [...library.folders, folder] }, storage);
  return folder;
}
export function renameLocalFolder(scope: string, id: string, name: string, storage: Storage = localStorage) {
  const library = localLibrary(scope, storage), folder = library.folders.find(f => f.id === id);
  if (!folder) throw new Error('This folder no longer exists.');
  name = name.trim().normalize('NFC');
  if (!name || name.includes('/') || name.length > 255) throw new Error('Use a folder name of 1–255 characters without a slash.');
  if (library.folders.some(f => f.id !== id && f.parentId === folder.parentId && f.name === name)) throw new Error('A folder with this name already exists here.');
  write(scope, { ...library, folders: library.folders.map(f => f.id === id ? { ...f, name } : f) }, storage);
}
export function deleteLocalFolder(scope: string, id: string, storage: Storage = localStorage) {
  const library = localLibrary(scope, storage);
  if (library.folders.some(f => f.parentId === id) || listEvidenceReports(scope, storage).some(r => library.entries[r.id]?.folderId === id)) throw new Error('Empty this folder before deleting it.');
  write(scope, { ...library, folders: library.folders.filter(f => f.id !== id) }, storage);
}
export function placeLocalReport(scope: string, reportId: string, folderId: string | null, metadata?: ReportMetadata, storage: Storage = localStorage) {
  const library = localLibrary(scope, storage);
  if (folderId && !library.folders.some(f => f.id === folderId)) throw new Error('The destination folder no longer exists.');
  library.entries[reportId] = { folderId, metadata: metadata ?? library.entries[reportId]?.metadata };
  write(scope, library, storage);
}
export function localReportEntry(scope: string, report: EvidenceReport, storage: Storage = localStorage): LocalEntry {
  return localLibrary(scope, storage).entries[report.id] ?? { folderId: null };
}
