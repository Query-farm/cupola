import { Search } from 'lucide-react';
import { Input } from '../ui/input';

export function ReportSearch({ query, onQuery, tag, onTag, tags, kind, onKind }: {
  query: string; onQuery: (value: string) => void; tag: string; onTag: (value: string) => void; tags: string[]; kind?: string; onKind?: (value: string) => void;
}) {
  return <div className="flex flex-wrap items-end gap-3">
    <label className="min-w-0 flex-1 basis-72 space-y-1.5 text-xs font-medium">
      <span>Search library</span>
      <span className="relative block"><Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 bg-card pl-9 font-normal" aria-label="Search library" placeholder="Search names, descriptions, and tags…" value={query} onChange={e => onQuery(e.target.value)} /></span>
    </label>
    {onKind && <label className="space-y-1.5 text-xs font-medium"><span>Type</span><select aria-label="Document type" value={kind ?? ''} onChange={e => onKind(e.target.value)} className="block h-9 w-full rounded-lg border border-input bg-card px-3 text-sm [appearance:auto]"><option value="">All types</option><option value="report">Reports</option><option value="notebook">Notebooks</option><option value="query">Queries</option></select></label>}
    <label className="min-w-0 flex-1 basis-44 space-y-1.5 text-xs font-medium sm:grow-0">
      <span>Tag</span>
      <select aria-label="Filter by tag" className="block h-9 w-full rounded-lg border border-input bg-card px-3 text-sm font-normal outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [appearance:auto]" value={tag} onChange={e => onTag(e.target.value)}><option value="">All tags</option>{[...new Set([...tags, ...(tag ? [tag] : [])])].map(t => <option key={t} value={t}>{t}</option>)}</select>
    </label>
  </div>;
}
