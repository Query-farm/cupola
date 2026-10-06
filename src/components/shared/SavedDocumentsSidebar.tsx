import { useState, type MouseEvent } from 'react';
import { ChevronRight, LayoutList, Plus, type LucideIcon } from 'lucide-react';

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
}) {
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
    <div className="text-sm">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={expanded}
          data-testid={testId}
          className={`${ROW} min-w-0 flex-1 font-bold text-primary`}
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
            className={`mr-1 h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
          <Icon aria-hidden className="mr-2 h-4 w-4 shrink-0" />
          <span className="truncate">{title}</span>
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{items.length}</span>
        </button>
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
      {expanded && (
        <nav aria-label={`Saved ${title.toLocaleLowerCase()}`} className="ml-4 border-l pb-1 pl-1">
          <a
            href={libraryHref}
            onClick={(event) => onNavigate(event)}
            aria-current={libraryActive ? 'page' : undefined}
            className={`${ROW} ml-5 text-muted-foreground hover:text-foreground ${libraryActive ? 'bg-muted font-medium text-foreground' : ''}`}
          >
            <LayoutList aria-hidden className="mr-2 h-4 w-4 shrink-0" />
            All {title.toLocaleLowerCase()}
          </a>
          {visible.map((item) => (
            <a
              key={item.id}
              href={item.href}
              onClick={(event) => onNavigate(event, item.id)}
              aria-current={activeId === item.id ? 'page' : undefined}
              title={item.title}
              className={`${ROW} ml-5 ${activeId === item.id ? 'bg-muted font-medium' : ''}`}
            >
              <ItemIcon aria-hidden className="mr-2 h-4 w-4 shrink-0" />
              <span className="truncate">{item.title}</span>
            </a>
          ))}
          {error ? (
            <p className="ml-5 px-2 py-1 text-xs text-destructive">{error}</p>
          ) : (
            !visible.length && <p className="ml-5 px-2 py-1 text-xs text-muted-foreground">{emptyMessage}</p>
          )}
        </nav>
      )}
    </div>
  );
}
