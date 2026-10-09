export interface ReportFolderNode { id: string; name: string; parentId: string | null; writable?: boolean }
export interface FolderBranch { id: string; name: string; folderId: string; writable?: boolean; children: FolderBranch[] }

export const directoryKey = (location: string, folderId: string | null = null) => JSON.stringify([location, folderId]);

/** Workers may expose children whose parents are hidden. Keep those reachable
 * at the visible root and tolerate malformed cycles without recursive loops. */
export function folderBranches(location: string, folders: ReportFolderNode[]): FolderBranch[] {
  const known = new Set(folders.map(f => f.id)), visited = new Set<string>();
  const children = new Map<string | null, ReportFolderNode[]>();
  for (const folder of folders) {
    const parent = folder.parentId && known.has(folder.parentId) ? folder.parentId : null;
    children.set(parent, [...children.get(parent) ?? [], folder]);
  }
  const visit = (folder: ReportFolderNode): FolderBranch => {
    visited.add(folder.id);
    return { id: directoryKey(location, folder.id), name: folder.name, folderId: folder.id, writable: folder.writable,
      children: (children.get(folder.id) ?? []).filter(f => !visited.has(f.id)).sort((a, b) => a.name.localeCompare(b.name)).map(visit) };
  };
  const roots = (children.get(null) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(visit);
  for (const folder of folders) if (!visited.has(folder.id)) roots.push(visit(folder));
  return roots;
}
