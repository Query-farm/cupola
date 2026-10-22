import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { folderAncestors } from '../../lib/reporting/folders';
import { FileTree, type FileTreeNode } from './FileTree';
import { ReportNotice } from './ReportNotice';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { directoryKey, folderBranches, type ReportFolderNode } from '../../lib/reporting/file-tree';
import { localLibrary } from '../../lib/reporting/local-library';
import { EVIDENCE_REPORTS_CHANGED } from '../../lib/evidence/reports';
import { locationLabel, type ReportLocation } from '../../lib/reporting/locations';

interface StorageTreeProps {
  locations: ReportLocation[]; scope: string; location: string; folderId: string | null;
  onSelect: (location: string, folderId: string | null) => void;
  objectKind?: string; workerOnly?: boolean; requiredAction?: string; picker?: boolean; disabled?: boolean; refreshKey?: unknown;
}
export function ReportStorageTree({ locations, scope, location, folderId, onSelect, picker, disabled, refreshKey, objectKind, workerOnly = false, requiredAction = 'create_report' }: StorageTreeProps) {
  const [local, setLocal] = useState<ReportFolderNode[]>([]), [remote, setRemote] = useState<Record<string, ReportFolderNode[]>>({});
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(100), [limited, setLimited] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({}), [loading, setLoading] = useState(false);
  useEffect(() => {
    const reload = () => setLocal(localLibrary(scope).folders);
    reload(); window.addEventListener(EVIDENCE_REPORTS_CHANGED, reload); window.addEventListener('storage', reload);
    return () => { window.removeEventListener(EVIDENCE_REPORTS_CHANGED, reload); window.removeEventListener('storage', reload); };
  }, [scope]);
  useEffect(() => {
    const abort = new AbortController();
    const supported = locations.filter(l => l.info);
    setRemote({}); setErrors({}); setLimited(false); setLoading(Boolean(supported.length));
    void Promise.allSettled(supported.map(async l => {
      try {
        const client = new ReportClient(l.url);
        const parentId = l.url === location ? folderId : null;
        const [children, ancestors] = await Promise.all([
          client.call('list_folders', { parent_folder_id: query.trim() ? null : parentId, recursive: Boolean(query.trim()), query: query.trim(), limit: BigInt(limit) }, abort.signal),
          folderAncestors(client, parentId, abort.signal),
        ]);
        if (!abort.signal.aborted && children.length >= limit) setLimited(true);
        const folders = [...new Map([...ancestors, ...children].map(f => [f.folder_id, f])).values()];
        if (!abort.signal.aborted) setRemote(old => ({ ...old, [l.url]: folders.map(f => ({ id: f.folder_id, name: f.name, parentId: f.parent_folder_id, writable: Boolean(l.info?.writable && f.allowed_actions.includes(requiredAction) && (!objectKind || !('creatable_kinds' in f) || (f as any).creatable_kinds.includes(objectKind))) })) }));
      } catch (e) { if (!abort.signal.aborted) setErrors(old => ({ ...old, [l.url]: reportError(e) })); }
    })).then(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [locations, refreshKey, objectKind, location, folderId, query, limit, requiredAction]);
  const branches = (url: string, folders: ReportFolderNode[]): FileTreeNode[] => {
    const convert = (items: ReturnType<typeof folderBranches>): FileTreeNode[] => items.map(f => ({ id: f.id, name: f.name, kind: 'folder', readOnly: picker && f.writable === false, detail: picker && f.writable === false ? 'Read-only folder' : undefined, children: convert(f.children) }));
    return convert(folderBranches(url, folders));
  };
  const nodes: FileTreeNode[] = [
    ...(!picker ? [{ id: directoryKey('all'), name: 'All documents', kind: 'collection' as const }] : []),
    ...(!workerOnly ? [{ id: directoryKey('local'), name: 'Local', kind: 'location' as const, children: branches('local', local) }] : []),
    ...locations.filter(l => l.info).map(l => ({ id: directoryKey(l.url), name: locationLabel(l, locations), kind: 'location' as const,
      children: branches(l.url, remote[l.url] ?? []), readOnly: picker && (!l.info?.writable || !l.info.root_allowed_actions.includes(requiredAction) || Boolean(objectKind && 'creatable_kinds' in l.info && !(l.info as any).creatable_kinds.includes(objectKind))), detail: errors[l.url] || (!l.info?.root_allowed_actions.includes(requiredAction) ? 'Read-only root; folders may allow writes' : undefined) })),
  ];
  return <div className="space-y-2"><Input aria-label="Find destination folder" placeholder="Search folders…" value={query} onChange={e => { setQuery(e.target.value); setLimit(100); }} /><FileTree nodes={nodes} label={picker ? 'Destination folder' : 'Report folders and locations'} selectedId={directoryKey(location, folderId)} disabled={disabled}
    onSelect={id => { const [url, folder] = JSON.parse(id); setQuery(''); setLimit(100); onSelect(url, folder); }} />
    {limited && <Button type="button" variant="outline" size="sm" onClick={() => setLimit(n => n + 100)}>Load more folders</Button>}
    {loading && <p role="status" className="px-2 text-xs text-muted-foreground">Loading folders…</p>}
    {Object.entries(errors).map(([url, message]) => <ReportNotice key={url} kind="error" title={`Could not load ${locations.find(l => l.url === url)?.name ?? 'folders'}`}>{message}</ReportNotice>)}
  </div>;
}
