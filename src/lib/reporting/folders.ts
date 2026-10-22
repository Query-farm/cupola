import { errorCode, type ReportClient } from './client';
import type { FolderRecord } from './contracts.generated';

/** Read only the selected path; no whole-library enumeration for a breadcrumb. */
export async function folderAncestors(client: ReportClient, id: string | null, signal?: AbortSignal): Promise<FolderRecord[]> {
  const folders: FolderRecord[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) {
    if (seen.size >= 100) throw new Error('The folder path exceeds the supported depth.');
    seen.add(id);
    let folder: FolderRecord;
    try { folder = await client.call('get_folder', { folder_id: id }, signal); }
    catch (error) {
      // A visible child does not imply access to every ancestor. Keep the
      // authorized path suffix, but never hide failure to read the selection.
      if (folders.length && ['NOT_FOUND', 'PERMISSION_DENIED'].includes(errorCode(error) ?? '')) return folders;
      throw error;
    }
    folders.unshift(folder); id = folder.parent_folder_id;
  }
  if (id) throw new Error('The worker returned a cyclic folder path.');
  return folders;
}
