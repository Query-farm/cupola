import type { ReactNode } from 'react';
import { ArrowLeft, FolderOpen } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportActionMenu, type ReportAction } from './ReportActionMenu';

export function ReportHeader({ title, location, status, onBack, onRename, actions, children }: {
  title: string; location: string; status?: ReactNode; onBack: () => void; onRename?: () => void; actions: ReportAction[]; children?: ReactNode;
}) {
  return <header aria-label="Report toolbar" className="z-10 flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-4 py-3 sm:px-5">
    <Button size="icon" variant="ghost" aria-label="Back to reports" title="Back to reports" onClick={onBack}><ArrowLeft /></Button>
    <div className="min-w-0 flex-1 basis-40 space-y-1">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><FolderOpen className="size-3 shrink-0" /><span className="truncate" title={location}>{location}</span></div>
      {onRename ? <button type="button" aria-label="Rename report" title="Rename report" onClick={onRename} className="block max-w-full truncate rounded text-left text-sm font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring">{title}</button>
        : <h1 className="truncate text-sm font-semibold" title={title}>{title}</h1>}
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">{status}</div>
    </div>
    <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">{children}<ReportActionMenu actions={actions} /></div>
  </header>;
}
