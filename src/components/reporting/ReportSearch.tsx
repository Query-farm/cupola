import { Search } from 'lucide-react';
import { Input } from '../ui/input';

export function ReportSearch({ query, onQuery, kind, onKind, label = 'Search library' }: {
  query: string; onQuery: (value: string) => void; kind?: string; onKind?: (value: string) => void; label?: string;
}) {
  return <div className="flex flex-wrap items-end gap-3">
    <label className="min-w-0 flex-1 basis-72 space-y-1.5 text-xs font-medium">
      <span>{label}</span>
      <span className="relative block"><Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 bg-card pl-9 font-normal" aria-label={label} placeholder="Search names and descriptions…" value={query} onChange={e => onQuery(e.target.value)} /></span>
    </label>
    {onKind && <label className="space-y-1.5 text-xs font-medium"><span>Type</span><select aria-label="Document type" value={kind ?? ''} onChange={e => onKind(e.target.value)} className="block h-9 w-full rounded-lg border border-input bg-card px-3 text-sm [appearance:auto]"><option value="">All types</option><option value="report">Reports</option><option value="notebook">Notebooks</option><option value="query">Queries</option></select></label>}
  </div>;
}
