import { useRef, useState, type MouseEvent } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import {
  Copy,
  Download,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { SavedDocumentAction } from '../../lib/saved-document-actions';

export interface SavedDocumentItem {
  id: string;
  title: string;
  href: string;
}

export function SavedDocumentRow({
  item,
  icon: Icon,
  active,
  documentKind,
  onNavigate,
  onAction,
}: {
  item: SavedDocumentItem;
  icon: LucideIcon;
  active: boolean;
  documentKind: 'notebook' | 'report';
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id?: string) => void;
  onAction: (id: string, action: SavedDocumentAction) => Promise<void>;
}) {
  const link = useRef<HTMLAnchorElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [keyboardAnchor, setKeyboardAnchor] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [name, setName] = useState(item.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  function showDialog(next: 'rename' | 'delete') {
    setName(item.title);
    setError('');
    setDialog(next);
  }
  async function perform(action: SavedDocumentAction) {
    const libraryLink = link.current?.closest('nav')?.querySelector<HTMLAnchorElement>('a');
    setPending(true);
    setError('');
    try {
      await onAction(item.id, action);
      setDialog(null);
      if (action.type === 'delete') requestAnimationFrame(() => libraryLink?.focus());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }
  const menuItems = (
    <>
      <ContextMenu.LinkItem
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        closeOnClick
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
      >
        <ExternalLink aria-hidden className="size-4" />
        Open in new tab
      </ContextMenu.LinkItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={pending} onClick={() => showDialog('rename')}>
        <Pencil aria-hidden />
        Rename…
      </DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={() => void perform({ type: 'duplicate' })}>
        <Copy aria-hidden />
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={() => void perform({ type: 'export' })}>
        <Download aria-hidden />
        {documentKind === 'report' ? 'Export report file' : 'Export notebook'}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={pending}
        variant="destructive"
        onClick={() => showDialog('delete')}
      >
        <Trash2 aria-hidden />
        Delete…
      </DropdownMenuItem>
    </>
  );

  return (
    <>
      <ContextMenu.Root open={contextOpen} onOpenChange={setContextOpen}>
        <ContextMenu.Trigger
          className={`ml-5 flex items-center rounded-md transition-colors hover:bg-muted/60 ${active ? 'bg-muted font-medium' : ''}`}
          onContextMenu={() => setKeyboardAnchor(null)}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              setKeyboardAnchor(link.current);
              setContextOpen(true);
            }
          }}
        >
          <a
            ref={link}
            href={item.href}
            onClick={(event) => onNavigate(event, item.id)}
            aria-current={active ? 'page' : undefined}
            title={item.title}
            className="flex min-w-0 flex-1 items-center rounded-md px-2 py-2 text-sm focus-visible:outline focus-visible:outline-ring"
          >
            <Icon aria-hidden className="mr-2 h-4 w-4 shrink-0" />
            <span className="truncate">{item.title}</span>
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${item.title}`}
              title={`Actions for ${item.title}`}
              className="mr-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-ring"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52" aria-label={`${item.title} actions`}>
              {menuItems}
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner
            anchor={keyboardAnchor ?? undefined}
            className="isolate z-50 outline-none"
          >
            <ContextMenu.Popup
              aria-label={`${item.title} actions`}
              className="max-h-(--available-height) min-w-52 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
            >
              {menuItems}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {error && !dialog && (
        <p role="alert" className="ml-5 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDialog(null);
        }}
      >
        <DialogContent initialFocus={dialog === 'rename' ? nameInput : cancel} finalFocus={link}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending && (dialog === 'delete' || name.trim()))
                void perform(
                  dialog === 'rename' ? { type: 'rename', title: name.trim() } : { type: 'delete' },
                );
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {dialog === 'rename' ? `Rename ${documentKind}` : `Delete ${documentKind}?`}
              </DialogTitle>
              <DialogDescription>
                {dialog === 'rename'
                  ? `Choose a new name for “${item.title}”.`
                  : `Delete “${item.title}” from this browser?`}
              </DialogDescription>
            </DialogHeader>
            {dialog === 'rename' && (
              <label className="grid gap-2">
                New name
                <Input
                  ref={nameInput}
                  value={name}
                  maxLength={documentKind === 'notebook' ? 200 : undefined}
                  onChange={(event) => setName(event.target.value)}
                  disabled={pending}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                ref={cancel}
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={dialog === 'delete' ? 'destructive' : 'default'}
                disabled={pending || (dialog === 'rename' && !name.trim())}
              >
                {dialog === 'rename' ? 'Save name' : 'Confirm delete'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
