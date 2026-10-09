import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import type { FolderRecord, Ownership, ReportRow } from '../../lib/reporting/contracts.generated';
import { reportError } from '../../lib/reporting/client';

export type ResourceAction = 'folder' | 'rename' | 'move' | 'delete' | 'ownership' | 'metadata' | 'redact';
export interface ResourceValues { name: string; folderId: string | null; ownership: Ownership; description: string; tags: string[]; reason: string }
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
export function ResourceDialog({ action, resource, folders, parentId = null, onClose, onApply }: {
  action: ResourceAction; resource?: FolderRecord | ReportRow; folders: FolderRecord[]; parentId?: string | null;
  onClose: () => void; onApply: (values: ResourceValues) => Promise<void>;
}) {
  const isFolder = resource && 'name' in resource;
  const [name, setName] = useState(isFolder ? resource.name : resource && 'envelope' in resource ? resource.envelope?.title ?? '' : '');
  const [folderId, setFolderId] = useState<string | null>(isFolder ? resource.parent_folder_id : resource && 'folder_id' in resource ? resource.folder_id : parentId);
  const [owner, setOwner] = useState(resource?.ownership.owner_ref ?? { kind: '', id: '', display_name: '' });
  const [parent, setParent] = useState(resource?.ownership.parent_owner_ref ?? { kind: '', id: '', display_name: '' });
  const [description, setDescription] = useState(resource && 'envelope' in resource ? resource.envelope?.description ?? '' : '');
  const [tags, setTags] = useState(resource && 'envelope' in resource ? resource.envelope?.tags.join(', ') ?? '' : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const title = { folder: 'New folder', rename: 'Rename folder', move: 'Move item', delete: 'Delete item', ownership: 'Transfer ownership', metadata: 'Report details', redact: 'Redact revision' }[action];
  const destinations = folders.filter(f => !isFolder || f.folder_id !== resource.folder_id && !isDescendant(f, resource.folder_id, folders));
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>
        {action === 'ownership' ? 'The worker resolves identities and enforces its own policy. Transfer preserves authorship and report content; your access may change.'
          : action === 'delete' ? `Delete “${name}”? Folders must be empty, including any children you cannot see.`
          : action === 'redact' ? 'Permanently remove this revision’s body and metadata. The audit entry remains. Head and published revisions must be replaced first.'
          : 'Changes are checked against the current worker version and permissions.'}
      </DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try {
        await onApply({ name, folderId, ownership: { owner_ref: { ...owner, display_name: '' }, parent_owner_ref: parent.id || parent.kind ? { ...parent, display_name: '' } : null }, description, tags: tags.split(',').map(t => t.trim()).filter(Boolean), reason }); onClose();
      } catch (e) { setError(reportError(e)); } finally { setBusy(false); } }}>
        {(action === 'folder' || action === 'rename' || action === 'metadata') && <label className="block space-y-1">Name<Input required aria-label="Name" value={name} onChange={e => setName(e.target.value)} /></label>}
        {(action === 'move' || action === 'folder') && <label className="block space-y-1">Destination folder<select aria-label="Destination folder" className="w-full rounded border bg-background p-2" value={folderId ?? ''} onChange={e => setFolderId(e.target.value || null)}><option value="">Library root</option>{destinations.map(f => <option key={f.folder_id} value={f.folder_id}>{folderPath(f, folders)}</option>)}</select></label>}
        {action === 'ownership' && <div className="grid grid-cols-2 gap-3">
          <label>Owner kind<Input required aria-label="Owner kind" value={owner.kind} onChange={e => setOwner({ ...owner, kind: e.target.value })} /></label>
          <label>Owner ID<Input required aria-label="Owner ID" value={owner.id} onChange={e => setOwner({ ...owner, id: e.target.value })} /></label>
          <label>Parent owner kind<Input aria-label="Parent owner kind" value={parent.kind} onChange={e => setParent({ ...parent, kind: e.target.value })} /></label>
          <label>Parent owner ID<Input aria-label="Parent owner ID" value={parent.id} onChange={e => setParent({ ...parent, id: e.target.value })} /></label>
        </div>}
        {action === 'metadata' && <><label className="block">Description<textarea aria-label="Description" className="w-full rounded border bg-background p-2" value={description} onChange={e => setDescription(e.target.value)} /></label><label className="block">Tags, separated by commas<Input aria-label="Tags" value={tags} onChange={e => setTags(e.target.value)} /></label></>}
        {action === 'redact' && <label className="block">Reason<Input aria-label="Reason" required value={reason} onChange={e => setReason(e.target.value)} /></label>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} type="submit">{busy ? 'Applying…' : action === 'delete' ? 'Delete' : action === 'redact' ? 'Redact permanently' : 'Apply'}</Button></DialogFooter>
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
