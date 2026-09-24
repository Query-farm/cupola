import { useState, type ReactNode } from 'react';
import { ChevronRight, Database, FolderOpen } from 'lucide-react';
import type { SemanticEntity, SemanticMember } from '../../lib/semantic-model';

type Item = { entity: SemanticEntity; member: SemanticMember };
const keyOf = (item: Item) => `${item.entity.catalogId}::${item.entity.entityId}::${item.member.member_id}`;

/** Native disclosure controls keep a large model browsable with keyboard support. */
export function SemanticMemberTree({ items, selected, searching, searchKey, renderMember }: {
  items: Item[]; selected: Set<string>; searching: boolean; searchKey: string;
  renderMember: (item: Item, kind: 'measures' | 'dimensions') => ReactNode;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const catalogs = new Map<string, Map<string, Item[]>>();
  for (const item of items) {
    const entities = catalogs.get(item.entity.catalogId) ?? new Map<string, Item[]>();
    const group = entities.get(item.entity.entityId) ?? [];
    group.push(item); entities.set(item.entity.entityId, group); catalogs.set(item.entity.catalogId, entities);
  }
  const isOpen = (key: string, fallback: boolean) => (expanded[`${searchKey}:${key}`] ?? (searching || fallback));
  const toggle = (key: string, open: boolean) => setExpanded(previous => ({ ...previous, [`${searchKey}:${key}`]: !open }));
  return <div className="max-h-[28rem] overflow-auto rounded-lg border" aria-label="Semantic field browser">
    {!items.length && <p className="p-5 text-center text-xs text-muted-foreground">No matching fields. Try another search or turn off Selected only.</p>}
    {[...catalogs].sort(([a], [b]) => a.localeCompare(b)).map(([catalog, entities]) => {
      const catalogKey = `catalog:${catalog}`;
      const open = isOpen(catalogKey, catalogs.size <= 2);
      const all = [...entities.values()].flat();
      const count = all.filter(item => selected.has(keyOf(item))).length;
      return <section key={catalog} className="border-b last:border-b-0">
        <button type="button" aria-expanded={open} aria-label={`Catalog ${catalog}`} className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]" onClick={() => toggle(catalogKey, open)}>
          <ChevronRight className={`size-3.5 shrink-0 ${open ? 'rotate-90' : ''}`} /><Database className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 break-words">{catalog}</span><span className="shrink-0 text-muted-foreground">{count ? `${count} selected · ` : ''}{all.length}</span>
        </button>
        {open && <div className="pl-3">{[...entities].sort(([a], [b]) => a.localeCompare(b)).map(([name, fields]) => {
          const entityKey = `entity:${catalog}:${name}`;
          const count = fields.filter(item => selected.has(keyOf(item))).length;
          const open = isOpen(entityKey, items.length <= 20 || count > 0);
          return <section key={entityKey} className="border-l">
            <button type="button" aria-expanded={open} aria-label={`Entity ${name} in ${catalog}`} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]" onClick={() => toggle(entityKey, open)}>
              <ChevronRight className={`size-3.5 shrink-0 ${open ? 'rotate-90' : ''}`} /><FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words font-medium">{name}</span><span className="shrink-0 text-muted-foreground">{count ? `${count} selected · ` : ''}{fields.length}</span>
            </button>
            {open && <div className="space-y-3 px-3 pb-3">{(['measures', 'dimensions'] as const).map(kind => {
              const members = fields.filter(item => (item.member.kind === 'measure') === (kind === 'measures')).sort((a, b) => (a.member.title || a.member.member_id).localeCompare(b.member.title || b.member.member_id));
              return members.length > 0 && <div key={kind}><h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{kind === 'measures' ? 'Measures' : 'Break down by'}</h4><div className="space-y-1">{members.map(item => renderMember(item, kind))}</div></div>;
            })}</div>}
          </section>;
        })}</div>}
      </section>;
    })}
  </div>;
}
