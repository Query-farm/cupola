import { Search, Tags } from 'lucide-react';
import { Input } from '../ui/input';

export function ReportSearch({ query, onQuery, tag, onTag, tags }: {
  query: string; onQuery: (value: string) => void; tag: string; onTag: (value: string) => void; tags: string[];
}) {
  return <div className="flex flex-wrap items-center gap-3">
    <label className="flex min-w-60 flex-1 items-center gap-2"><Search aria-hidden className="size-4 shrink-0 text-muted-foreground" /><Input aria-label="Search reports" placeholder="Search names, descriptions, and tags…" value={query} onChange={e => onQuery(e.target.value)} /></label>
    <label className="flex items-center gap-2 text-sm"><Tags aria-hidden className="size-4 text-muted-foreground" /><span>Tag</span><select aria-label="Filter by tag" className="max-w-60 rounded border bg-background px-3 py-2 [appearance:auto]" value={tag} onChange={e => onTag(e.target.value)}><option value="">All tags</option>{[...new Set([...tags, ...(tag ? [tag] : [])])].map(t => <option key={t} value={t}>{t}</option>)}</select></label>
  </div>;
}
