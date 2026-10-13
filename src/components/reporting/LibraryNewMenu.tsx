import { Plus, FileChartColumn, NotebookPen, FileCode, FolderPlus } from 'lucide-react';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
export type LibraryDocumentKind = 'query' | 'notebook' | 'report';
export function LibraryNewMenu({ kinds = ['query', 'notebook', 'report'], onCreate, onFolder, disabled, compact }: {
  kinds?: readonly string[]; onCreate: (kind: LibraryDocumentKind) => void; onFolder?: () => void; disabled?: boolean; compact?: boolean;
}) {
  return <DropdownMenu><DropdownMenuTrigger render={<Button variant={compact ? "ghost" : "default"} size={compact ? "icon-sm" : "default"} aria-label={compact ? "New document" : undefined} disabled={disabled || !kinds.length && !onFolder} />}><Plus />{!compact && 'New'}</DropdownMenuTrigger><DropdownMenuContent align="end">
    {kinds.includes('query') && <DropdownMenuItem onClick={() => onCreate('query')}><FileCode />New query</DropdownMenuItem>}
    {kinds.includes('notebook') && <DropdownMenuItem onClick={() => onCreate('notebook')}><NotebookPen />New notebook</DropdownMenuItem>}
    {kinds.includes('report') && <DropdownMenuItem onClick={() => onCreate('report')}><FileChartColumn />New report</DropdownMenuItem>}
    {onFolder && <><DropdownMenuSeparator /><DropdownMenuItem onClick={onFolder}><FolderPlus />New folder</DropdownMenuItem></>}
  </DropdownMenuContent></DropdownMenu>;
}
