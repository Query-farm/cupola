import { Fragment } from 'react';
import { Copy, Download, FileText, FolderInput, History, Info, Maximize2, MoreHorizontal, Pencil, Trash2, UserRound, type LucideIcon } from 'lucide-react';
import { buttonVariants } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';

const definitions = {
  ownership: ['Transfer ownership…', UserRound], copy: ['Save a copy…', Copy], move: ['Move…', FolderInput], history: ['Version history', History],
  details: ['Details', Info], rename: ['Rename…', Pencil], source: ['View source', FileText],
  export: ['Download report file', Download], focus: ['Focus report', Maximize2], delete: ['Delete…', Trash2],
} satisfies Record<string, [string, LucideIcon]>;
export interface ReportAction { id: string; label: string; icon?: LucideIcon; onClick: () => void; disabled?: boolean; separator?: boolean; destructive?: boolean }
export function reportAction(id: keyof typeof definitions, onClick: () => void, disabled = false): ReportAction {
  const [label, icon] = definitions[id];
  return { id, label, icon, onClick, disabled, destructive: id === 'delete', separator: id === 'delete' };
}
/** The same vocabulary and keyboard-accessible actions in reports and library rows. */
export function ReportActionMenu({ actions, label = 'More report actions' }: { actions: ReportAction[]; label?: string }) {
  if (!actions.length) return null;
  return <DropdownMenu><DropdownMenuTrigger aria-label={label} title={label} className={buttonVariants({ variant: 'ghost', size: 'icon' })}><MoreHorizontal /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-52">{actions.map((action, i) => <Fragment key={action.id}>
      {i > 0 && action.separator && <DropdownMenuSeparator />}
      <DropdownMenuItem disabled={action.disabled} onClick={action.onClick} className={action.destructive ? 'text-destructive' : undefined}>{action.icon && <action.icon />}{action.label}</DropdownMenuItem>
    </Fragment>)}</DropdownMenuContent>
  </DropdownMenu>;
}
