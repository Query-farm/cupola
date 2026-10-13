import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { captureSources, type DocumentConfiguration } from '../../lib/reporting/documents';
import { engine } from '../../lib/shell-bridge';
import { serviceLocation } from '../../lib/reporting/client';
import type { CatalogData } from '../../lib/service';

/** Explicit connection declarations; SQL is never guessed or rewritten. */
export function DocumentSources({ configuration, catalogs, workspaceId, onApply, onClose }: {
  configuration: DocumentConfiguration; catalogs: readonly CatalogData[]; workspaceId?: string;
  onApply: (value: DocumentConfiguration) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(configuration);
  const [error, setError] = useState('');
  const available = captureSources(catalogs, workspaceId);
  const candidates = [...value.sources, ...available.filter(s => !value.sources.some(v => v.alias === s.alias))];
  function update(alias: string, change: Partial<DocumentConfiguration['sources'][number]>) {
    setValue(v => ({ ...v, sources: v.sources.map(s => s.alias === alias ? { ...s, ...change } : s) }));
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-xl"><DialogHeader><DialogTitle>Data sources</DialogTitle><DialogDescription>Choose the connections this document uses. Required connections must be available before running. Save the document to share these settings.</DialogDescription></DialogHeader>
    <div className="space-y-4 text-sm">
      <fieldset className="space-y-3"><legend className="mb-2 font-medium">Connections</legend>{candidates.length ? candidates.map(source => {
        const included = value.sources.some(s => s.alias === source.alias), connected = engine.catalogStatuses.get(source.alias);
        const matches = connected?.state === 'attached' && serviceLocation(connected.url) === serviceLocation(source.location) && connected.catalogName === source.catalog_name;
        const replacement = available.find(s => s.alias === source.alias);
        return <div key={source.alias} className="space-y-1 rounded-lg border p-3">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={included} disabled={value.context.default_source_alias === source.alias} onChange={e => setValue(v => ({ ...v, sources: e.target.checked ? [...v.sources, source] : v.sources.filter(s => s.alias !== source.alias) }))} />{source.alias}</label>
          <p className="break-all text-xs text-muted-foreground">{source.catalog_name} · {source.location}</p>
          <p className="text-xs text-muted-foreground">{matches ? 'Connected' : 'Connection unavailable or different. Connect this worker using the catalog sidebar.'}</p>
          {included && <label className="flex items-center gap-2"><input type="checkbox" checked={source.required || value.context.default_source_alias === source.alias} disabled={value.context.default_source_alias === source.alias} onChange={e => update(source.alias, { required: e.target.checked })} />Required to run</label>}
          {included && !matches && replacement && <Button size="sm" variant="outline" onClick={() => update(source.alias, { ...replacement, required: source.required })}>Use currently connected {replacement.catalog_name}</Button>}
        </div>;
      }) : <p className="text-muted-foreground">No worker connections. Queries can still use the local memory database.</p>}</fieldset>
      <label className="block space-y-1">Default catalog<select aria-label="Default catalog" className="block h-9 w-full rounded-lg border bg-background px-3" value={value.context.default_source_alias ?? ''} onChange={e => setValue(v => ({ ...v, context: { ...v.context, default_source_alias: e.target.value || null, default_schema: e.target.value ? v.context.default_schema : null }, sources: v.sources.map(s => s.alias === e.target.value ? { ...s, required: true } : s) }))}><option value="">Local memory</option>{value.sources.map(s => <option key={s.alias} value={s.alias}>{s.alias}</option>)}</select></label>
      <label className="block space-y-1">Default schema<Input disabled={!value.context.default_source_alias} value={value.context.default_schema ?? ''} placeholder="main" onChange={e => setValue(v => ({ ...v, context: { ...v.context, default_schema: e.target.value || null } }))} /></label>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex gap-2"><Button onClick={() => { try { onApply(value); } catch { setError('Could not keep these settings on this device. Free browser storage and try again.'); } }}>Apply to draft</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
    </div>
  </DialogContent></Dialog>;
}
