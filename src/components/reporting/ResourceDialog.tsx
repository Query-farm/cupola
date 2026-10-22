import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import type { FolderRecord, ReportRow, ReportSummary } from '../../lib/reporting/contracts.generated';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { folderAncestors } from '../../lib/reporting/folders';
import { ReportStorageTree } from './ReportStorageTree';
import type { ReportLocation } from '../../lib/reporting/locations';
import { FileTree, type FileTreeNode } from './FileTree';
import { ReportNotice } from './ReportNotice';
import { directoryKey, folderBranches } from '../../lib/reporting/file-tree';

export type ResourceAction = 'folder' | 'rename' | 'move' | 'delete' | 'metadata' | 'redact';
export interface ResourceValues { name: string; folderId: string | null; description: string; tags: string[]; reason: string }
export function folderPath(folder: FolderRecord, folders: FolderRecord[]): string {
  const parts = [folder.name], seen = new Set([folder.folder_id]);
  let parent = folder.parent_folder_id;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const found = folders.find(f => f.folder_id === parent);
    if (!found) break;
    parts.unshift(found.name); parent = found.parent_folder_id;
  }
  return parts.join(' / ');
}
export function ResourceDialog({ action, resource, folders, parentId = null, libraryName = 'Library root', workerLocation, rootActions, writable, onClose, onApply }: {
  action: ResourceAction; resource?: FolderRecord | ReportRow | ReportSummary; folders: FolderRecord[]; parentId?: string | null;
  libraryName?: string; workerLocation?: ReportLocation; rootActions: string[]; writable: boolean;
  onClose: () => void; onApply: (values: ResourceValues) => Promise<void>;
}) {
  const isFolder = resource && 'name' in resource;
  const [name, setName] = useState(isFolder ? resource.name : resource && 'title' in resource ? resource.title ?? '' : resource && 'envelope' in resource ? resource.envelope?.title ?? '' : '');
  const [folderId, setFolderId] = useState<string | null>(isFolder ? resource.parent_folder_id : resource && 'folder_id' in resource ? resource.folder_id : parentId);
  const [description, setDescription] = useState(resource && 'envelope' in resource ? resource.envelope?.description ?? '' : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const title = { folder: 'New folder', rename: 'Rename folder', move: 'Move item', delete: 'Delete item', metadata: 'Report details', redact: 'Redact revision' }[action];
  const destinations = folders.filter(f => !isFolder || f.folder_id !== resource.folder_id && !isDescendant(f, resource.folder_id, folders));
  const pickingFolder = action === 'move' || action === 'folder';
  const requiredAction = action === 'folder' || isFolder ? 'create_folder' : 'create_report';
  const [checkedFolder, setCheckedFolder] = useState<FolderRecord | null>(null), [checking, setChecking] = useState(false);
  const locations = useMemo(() => workerLocation ? [workerLocation] : [], [workerLocation?.url, workerLocation?.info]);
  useEffect(() => {
    setCheckedFolder(null); setChecking(false);
    if (!pickingFolder || !folderId || !workerLocation) return;
    const abort = new AbortController(); setChecking(true);
    void folderAncestors(new ReportClient(workerLocation.url), folderId, abort.signal)
      .then(path => { if (isFolder && path.some(folder => folder.folder_id === resource.folder_id)) throw new Error('A folder cannot move into itself or its descendants.'); if (!abort.signal.aborted) setCheckedFolder(path.at(-1) ?? null); }).catch(e => { if (!abort.signal.aborted) setError(reportError(e)); })
      .finally(() => { if (!abort.signal.aborted) setChecking(false); });
    return () => abort.abort();
  }, [pickingFolder, folderId, workerLocation?.url]);
  const canSave = !pickingFolder || writable && (folderId ? (workerLocation ? checkedFolder : destinations.find(f => f.folder_id === folderId))?.allowed_actions : rootActions)?.includes(requiredAction);
  const branches = folderBranches('worker', destinations.map(f => ({ id: f.folder_id, name: f.name, parentId: f.parent_folder_id, writable: writable && f.allowed_actions.includes(requiredAction) })));
  const nodes = (items: typeof branches): FileTreeNode[] => items.map(f => ({ id: f.id, name: f.name, kind: 'folder', readOnly: !f.writable, children: nodes(f.children) }));
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>
        {action === 'delete' ? `Delete “${name}”? Folders must be empty, including any children you cannot see.`
          : action === 'redact' ? 'Permanently remove this revision’s body and metadata. The audit entry remains. Head and published revisions must be replaced first.'
          : 'Changes are checked against the current worker version and permissions.'}
      </DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (checking || !canSave || busy) return; setBusy(true); setError(''); try {
        await onApply({ name, folderId, description, tags: resource && 'envelope' in resource ? resource.envelope?.tags ?? [] : [], reason }); onClose();
      } catch (e) { setError(reportError(e)); } finally { setBusy(false); } }}>
        {(action === 'folder' || action === 'rename' || action === 'metadata') && <label className="block space-y-1">Name<Input required aria-label="Name" value={name} onChange={e => setName(e.target.value)} /></label>}
        {pickingFolder && <div className="space-y-2"><p className="text-sm font-medium">Destination folder</p><div className="max-h-72 overflow-auto rounded border p-2"><>{workerLocation ? <ReportStorageTree picker workerOnly requiredAction={requiredAction} locations={locations} scope="" location={workerLocation.url} folderId={folderId} onSelect={(_, id) => setFolderId(id)} disabled={busy} /> : <FileTree label="Destination folder" selectedId={directoryKey('worker', folderId)} disabled={busy} onSelect={id => setFolderId(JSON.parse(id)[1])}
          nodes={[{ id: directoryKey('worker'), name: libraryName, kind: 'location', readOnly: !writable || !rootActions.includes(requiredAction), children: nodes(branches) }]} />}</></div>
          {!canSave && <ReportNotice kind="permission" title="Read-only destination">Choose a folder that allows {requiredAction === 'create_folder' ? 'new folders' : 'reports'}.</ReportNotice>}
        </div>}
        {action === 'metadata' && <label className="block">Description (optional)<textarea aria-label="Description" className="w-full rounded border bg-background p-2" value={description} onChange={e => setDescription(e.target.value)} /></label>}
        {action === 'redact' && <label className="block">Reason<Input aria-label="Reason" required value={reason} onChange={e => setReason(e.target.value)} /></label>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || checking || !canSave} type="submit">{busy ? 'Applying…' : action === 'delete' ? 'Delete' : action === 'redact' ? 'Redact permanently' : 'Apply'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
function isDescendant(folder: FolderRecord, id: string, folders: FolderRecord[]): boolean {
  const seen = new Set<string>();
  let parent = folder.parent_folder_id;
  while (parent && !seen.has(parent)) { if (parent === id) return true; seen.add(parent); parent = folders.find(f => f.folder_id === parent)?.parent_folder_id ?? null; }
  return false;
}
