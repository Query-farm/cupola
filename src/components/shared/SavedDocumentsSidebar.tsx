import { useId, useState, type MouseEvent } from 'react';
import { ChevronRight, Plus, type LucideIcon } from 'lucide-react';
import { SavedDocumentRow } from './SavedDocumentRow';
import type { SavedDocumentAction } from '../../lib/saved-document-actions';

const ROW = 'flex items-center rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/60';
/** Shared saved-document roots, matching the catalog tree while preserving real links. */
export function SavedDocumentsSidebar({
  title,
  icon: Icon,
  itemIcon: ItemIcon,
  openKey,
  testId,
  items,
  search = '',
  libraryHref,
  onNavigate,
  onCreate,
  createLabel = 'New document',
  activeId,
  libraryActive,
  error,
  emptyMessage,
  documentKind,
  onAction,
}: {
  title: string;
  icon: LucideIcon;
  itemIcon: LucideIcon;
  openKey: string;
  testId: string;
  items: { id: string; title: string; href: string }[];
  search?: string;
  libraryHref: string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id?: string) => void;
  onCreate?: () => void;
  createLabel?: string;
  activeId?: string | null;
  libraryActive?: boolean;
  error?: string;
  emptyMessage: string;
  documentKind: 'notebook' | 'report';
  onAction: (id: string, action: SavedDocumentAction) => Promise<void>;
}) {
  const itemsId = useId();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(openKey) !== '0';
    } catch {
      return true;
    }
  });
  const visible = items.filter((item) => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  if (search && !visible.length && !error) return null;
  const expanded = open || Boolean(search);
  return (
    <nav aria-label={`Saved ${title.toLocaleLowerCase()}`} className="text-sm">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={itemsId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title.toLocaleLowerCase()}`}
          data-testid={testId}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 focus-visible:outline focus-visible:outline-ring"
          onClick={() =>
            setOpen((value) => {
              try {
                localStorage.setItem(openKey, value ? '0' : '1');
              } catch {
                /* Keep the local toggle if storage is unavailable. */
              }
              return !value;
            })
          }
        >
          <ChevronRight
            aria-hidden
            className={`h-4 w-4 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
        <a
          href={libraryHref}
          onClick={(event) => onNavigate(event)}
          aria-current={libraryActive ? 'page' : undefined}
          className={`${ROW} min-w-0 flex-1 pl-0 font-bold text-primary focus-visible:outline focus-visible:outline-ring ${libraryActive ? 'bg-muted' : ''}`}
        >
          <Icon aria-hidden className="mr-2 h-4 w-4 shrink-0" />
          <span className="truncate">{title}</span>
          <span aria-hidden className="ml-1.5 text-xs font-normal text-muted-foreground">{items.length}</span>
        </a>
        {onCreate && (
          <button
            type="button"
            onClick={onCreate}
            aria-label={createLabel}
            title={createLabel}
            className="mr-1 rounded-md p-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          >
            <Plus aria-hidden className="size-4" />
          </button>
        )}
      </div>
      <div id={itemsId} hidden={!expanded} className="ml-4 border-l pb-1 pl-1">
        {visible.map((item) => (
          <SavedDocumentRow
            key={item.id}
            item={item}
            icon={ItemIcon}
            active={activeId === item.id}
            documentKind={documentKind}
            onNavigate={onNavigate}
            onAction={onAction}
          />
        ))}
        {error ? (
          <p className="ml-5 px-2 py-1 text-xs text-destructive">{error}</p>
        ) : (
          !visible.length && <p className="ml-5 px-2 py-1 text-xs text-muted-foreground">{emptyMessage}</p>
        )}
      </div>
    </nav>
  );
}
