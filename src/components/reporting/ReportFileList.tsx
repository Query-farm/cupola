import type { ReactNode } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { Button } from '../ui/button';

export interface ReportFileItem {
  id: string; name: string; kind: 'folder' | 'report'; description?: string;
  detail?: ReactNode; state: ReactNode; actions?: ReactNode; onOpen: () => void;
}
/** Common contents view for browser-local and worker-backed directories. */
export function ReportFileList({ items, detailLabel = 'Location', emptyMessage = 'No reports found.', filters, heading = 'Folder contents', loadingMessage }: {
  items: ReportFileItem[]; detailLabel?: string; emptyMessage?: string; filters?: ReactNode; heading?: string; loadingMessage?: string;
}) {
  return <section aria-label={heading} className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
    <header className="flex items-center justify-between gap-3 px-4 py-3">
      <h2 className="text-sm font-semibold">{heading}</h2>
      {!loadingMessage && <span className="text-xs text-muted-foreground">{items.length} {items.length === 1 ? 'item' : 'items'}</span>}
    </header>
    {filters && <div className="border-t bg-muted/50 p-4">{filters}</div>}
    {loadingMessage ? <p role="status" className="border-t p-6 text-sm text-muted-foreground">{loadingMessage}</p> : <>
      <table className="w-full table-fixed text-left text-sm">
        <thead className="border-y bg-muted/30 text-xs text-muted-foreground"><tr>
          <th scope="col" className="px-4 py-2.5 md:w-1/2">Name</th>
          <th scope="col" className="hidden px-4 py-2.5 md:table-cell">{detailLabel}</th>
          <th scope="col" className="hidden px-4 py-2.5 md:table-cell">State</th>
          <th scope="col" className="w-14 px-2 py-2.5"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>{items.map(item => <tr key={item.id} className="border-b last:border-0 hover:bg-muted/30 focus-within:bg-muted/30">
          <td className="p-4 align-top">
            <div className="flex min-w-0 items-start gap-3">
              {item.kind === 'folder' ? <FolderOpen aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" /> : <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <Button variant="link" className="h-auto max-w-full justify-start whitespace-normal break-words p-0 text-left leading-5" onClick={item.onOpen}>{item.name}</Button>
                {item.description && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{item.description}</p>}
                <div className="mt-1 space-y-0.5 break-words text-xs text-muted-foreground md:hidden">
                  {item.detail && <p>{detailLabel}: {item.detail}</p>}<p>{item.state}</p>
                </div>
              </div>
            </div>
          </td>
          <td className="hidden break-words p-4 align-top text-muted-foreground md:table-cell">{item.detail}</td>
          <td className="hidden break-words p-4 align-top text-muted-foreground md:table-cell">{item.state}</td>
          <td className="px-2 py-3 align-top"><div className="flex justify-end">{item.actions}</div></td>
        </tr>)}</tbody>
      </table>
      {!items.length && <p className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</p>}
    </>}
  </section>;
}
