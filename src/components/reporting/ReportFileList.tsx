import type { ReactNode } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { Button } from '../ui/button';

export interface ReportFileItem {
  id: string; name: string; kind: 'folder' | 'report'; description?: string;
  detail?: ReactNode; state: ReactNode; actions?: ReactNode; onOpen: () => void;
}
/** Common contents view for browser-local and worker-backed directories. */
export function ReportFileList({ items, detailLabel = 'Location', emptyMessage = 'No reports found.' }: {
  items: ReportFileItem[]; detailLabel?: string; emptyMessage?: string;
}) {
  return <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead><tr className="border-b bg-muted/40"><th className="p-3">Name</th><th className="p-3">{detailLabel}</th><th className="p-3">State</th><th className="p-3"><span className="sr-only">Actions</span></th></tr></thead><tbody>
    {items.map(item => <tr key={item.id} className="border-b last:border-0"><td className="p-3"><Button variant="link" onClick={item.onOpen}>{item.kind === 'folder' ? <FolderOpen aria-hidden /> : <FileText aria-hidden />}{item.name}</Button>{item.description && <p className="mt-1 max-w-xl text-xs text-muted-foreground">{item.description}</p>}</td><td className="p-3">{item.detail}</td><td className="p-3">{item.state}</td><td className="p-3"><div className="flex flex-wrap gap-1">{item.actions}</div></td></tr>)}
  </tbody></table>{!items.length && <p className="p-5 text-sm text-muted-foreground">{emptyMessage}</p>}</div>;
}
