import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, HardDrive, Layers, LockKeyhole } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface FileTreeNode {
  id: string; name: string; kind: 'location' | 'folder' | 'collection' | 'report';
  children?: FileTreeNode[]; disabled?: boolean; readOnly?: boolean; detail?: string;
  href?: string; content?: ReactNode;
}

/** Shared folder navigation and destination selection. Expansion is independent
 * of selection so read-only parents can still reveal writable children. */
export function FileTree({ nodes, label, selectedId, onSelect, disabled = false, initialExpandedIds = [], expandAll = false, autoFocusSelection = true, onNavigate }: {
  nodes: FileTreeNode[]; label: string; selectedId?: string;
  onSelect: (id: string) => void; disabled?: boolean;
  initialExpandedIds?: string[]; expandAll?: boolean; autoFocusSelection?: boolean;
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialExpandedIds));
  const [focused, setFocused] = useState<string | undefined>(selectedId);
  const root = useRef<HTMLUListElement>(null);
  const search = useRef({ value: '', time: 0 });
  const entries = useMemo(() => {
    const result = new Map<string, { node: FileTreeNode; parent?: string }>();
    const visit = (items: FileTreeNode[], parent?: string) => items.forEach(node => {
      result.set(node.id, { node, parent }); visit(node.children ?? [], node.id);
    });
    visit(nodes); return result;
  }, [nodes]);
  useEffect(() => { setFocused(selectedId); }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    setExpanded(old => {
      const next = new Set(old); let parent = entries.get(selectedId)?.parent;
      while (parent) { next.add(parent); parent = entries.get(parent)?.parent; }
      return next;
    });
    if (autoFocusSelection && entries.has(selectedId) && document.activeElement === document.body) focus(selectedId);
  }, [selectedId, entries, autoFocusSelection]);
  const visible: FileTreeNode[] = [];
  const collect = (items: FileTreeNode[]) => items.forEach(node => { visible.push(node); if (expandAll || expanded.has(node.id)) collect(node.children ?? []); });
  collect(nodes);
  const tabStop = visible.some(n => n.id === focused) ? focused : visible[0]?.id;
  function toggle(id: string, open = !expanded.has(id)) {
    setExpanded(old => { const next = new Set(old); if (open) next.add(id); else next.delete(id); return next; });
  }
  function focus(id?: string) {
    if (!id) return;
    setFocused(id);
    requestAnimationFrame(() => {
      // Selecting a directory may replace the contents view and its tree.
      const tree = root.current ?? document.querySelector<HTMLElement>(`[role="tree"][aria-label="${CSS.escape(label)}"]`);
      tree?.querySelector<HTMLElement>(`[data-file-node="${CSS.escape(id)}"]`)?.focus();
    });
  }
  function key(event: KeyboardEvent, node: FileTreeNode) {
    const index = visible.findIndex(n => n.id === node.id);
    if (event.key === 'ArrowDown') focus(visible[index + 1]?.id);
    else if (event.key === 'ArrowUp') focus(visible[index - 1]?.id);
    else if (event.key === 'Home') focus(visible[0]?.id);
    else if (event.key === 'End') focus(visible.at(-1)?.id);
    else if (event.key === 'ArrowRight') {
      if (node.children?.length) { if (!expanded.has(node.id)) toggle(node.id, true); else focus(node.children[0].id); }
    } else if (event.key === 'ArrowLeft') {
      if (expanded.has(node.id)) toggle(node.id, false); else focus(entries.get(node.id)?.parent);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (!disabled && !node.disabled) { onSelect(node.id); focus(node.id); }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now(); search.current = { value: (now - search.current.time < 700 ? search.current.value : '') + event.key.toLocaleLowerCase(), time: now };
      focus([...visible.slice(index + 1), ...visible.slice(0, index + 1)].find(n => n.name.toLocaleLowerCase().startsWith(search.current.value))?.id);
    } else return;
    event.preventDefault(); event.stopPropagation();
  }
  const render = (items: FileTreeNode[], level = 1) => items.map((node, index) => {
    const open = expandAll || expanded.has(node.id), branch = Boolean(node.children?.length);
    const Icon = node.kind === 'report' ? FileText : node.kind === 'location' ? HardDrive : node.kind === 'collection' ? Layers : open ? FolderOpen : Folder;
    return <Fragment key={node.id}><li role="treeitem" aria-label={node.name} aria-level={level} aria-posinset={index + 1} aria-setsize={items.length} aria-selected={selectedId === node.id}
      aria-expanded={branch ? open : undefined} aria-disabled={disabled || node.disabled || undefined} tabIndex={tabStop === node.id ? 0 : -1}
      data-file-node={node.id} onFocus={e => { if (e.target === e.currentTarget) setFocused(node.id); }}
      onKeyDown={e => { if (e.target === e.currentTarget || e.target instanceof HTMLAnchorElement && !['Enter', ' '].includes(e.key)) key(e, node); }}
      className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <div title={node.detail} style={{ paddingLeft: 8 + (level - 1) * 16 }} className={cn('flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-muted/60', selectedId === node.id && 'bg-muted font-medium', (disabled || node.disabled) && 'text-muted-foreground')}
        onClick={e => { if ((e.target as HTMLElement).closest('a,button,input,[role="menuitem"]')) return; focus(node.id); if (!disabled && !node.disabled) onSelect(node.id); }}>
        {branch ? <button type="button" tabIndex={-1} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} className="flex size-5 shrink-0 items-center justify-center" onClick={e => { e.stopPropagation(); focus(node.id); toggle(node.id); }}><ChevronRight aria-hidden className={cn('size-4 transition-transform', open && 'rotate-90')} /></button> : <span className="size-5 shrink-0" />}
        {node.content ?? <>{node.href ? <a href={node.href} title={node.detail ?? node.name} aria-current={selectedId === node.id ? 'page' : undefined} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 focus-visible:outline focus-visible:outline-ring" onClick={e => onNavigate?.(e, node.id)}><Icon aria-hidden className="size-4 shrink-0" /><span className="truncate">{node.name}</span></a>
          : <><Icon aria-hidden className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{node.name}</span></>}{(node.disabled || node.readOnly) && <LockKeyhole aria-label="Read-only" className="size-3 shrink-0" />}</>}
      </div>
    </li>{branch && open && render(node.children!, level + 1)}</Fragment>;
  });
  return <ul ref={root} role="tree" aria-label={label} className="min-w-0 space-y-0.5">{render(nodes)}</ul>;
}
