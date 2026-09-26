import { useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { formatParameterValue, MAX_PARAMETER_OPTIONS, type ParameterOption, type ParameterOptionsState } from '../../lib/evidence/parameters';
import type { EvidenceParameter, ParameterValue } from '../../lib/evidence/reports';

/** Rendering every choice of a long list costs more than anyone scrolls; search narrows it. */
const RENDERED_CHOICES = 200;
const ALL = Symbol('all');
type Item = ParameterOption | typeof ALL;

/** A searchable single or multiple choice list for select / multi_select parameters. */
export function ParameterChoicePicker({ parameter, value, onChange, label, disabled, state }: {
  parameter: EvidenceParameter; value: ParameterValue; onChange: (value: ParameterValue) => void;
  label: string; disabled?: boolean; state?: ParameterOptionsState;
}) {
  const multi = parameter.type === 'multi_select';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const options = state?.options ?? [];
  const selected = multi ? (Array.isArray(value) ? value.map(String) : []) : value === null || value === '' ? [] : [String(value)];
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter(option => option.label.toLowerCase().includes(needle) || String(option.value).toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const items: Item[] = [...(parameter.allowAll && !query ? [ALL] as Item[] : []), ...matches.slice(0, RENDERED_CHOICES)];
  const loading = state?.status === 'loading';
  const summary = loading && !options.length ? 'Loading choices…' : formatParameterValue(parameter, value, options);

  function choose(item: Item) {
    if (item === ALL) { onChange(multi ? [] : null); if (!multi) setOpen(false); return; }
    if (!multi) { onChange(item.value); setOpen(false); return; }
    const current = Array.isArray(value) ? value : [];
    const on = current.some(entry => String(entry) === String(item.value));
    onChange(on ? current.filter(entry => String(entry) !== String(item.value)) : [...current, item.value]);
  }
  const isSelected = (item: Item) => item === ALL ? selected.length === 0 : selected.includes(String(item.value));
  function move(delta: number) {
    const next = Math.max(0, Math.min(items.length - 1, active + delta));
    setActive(next);
    list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(''); setActive(0); } }}>
    <PopoverTrigger
      disabled={disabled}
      aria-label={`${label}: ${summary}`}
      data-testid={`parameter-choices-${parameter.key}`}
      className="flex h-8 w-full min-w-0 items-center gap-1 rounded-lg border border-input bg-background px-2 text-left text-sm font-normal disabled:opacity-50">
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
    </PopoverTrigger>
    <PopoverContent align="start" className="w-72 p-0">
      <div className="border-b p-2">
        <input
          autoFocus role="combobox" aria-expanded aria-controls={listId} aria-label={`Search ${label}`}
          aria-activedescendant={items.length ? `${listId}-${active}` : undefined}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={`Search ${options.length.toLocaleString()} choices`} value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
            else if (event.key === 'Enter' && items[active] !== undefined) { event.preventDefault(); choose(items[active]); }
          }} />
      </div>
      <ul ref={list} id={listId} role="listbox" aria-label={label} aria-multiselectable={multi || undefined} className="max-h-64 overflow-auto p-1 text-sm">
        {items.map((item, index) => <li
          key={item === ALL ? '\u0000all' : `${typeof item.value}:${item.value}`}
          id={`${listId}-${index}`} data-index={index} role="option" aria-selected={isSelected(item)}
          className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${index === active ? 'bg-muted' : ''}`}
          onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>
          <span className={`flex size-4 shrink-0 items-center justify-center rounded-sm ${multi ? 'border border-input' : ''}`}>{isSelected(item) && <Check className="size-3.5" aria-hidden />}</span>
          <span className="truncate">{item === ALL ? 'All' : item.label}</span>
        </li>)}
      </ul>
      {(state?.status === 'error' || !items.length || matches.length > RENDERED_CHOICES || (state?.status === 'ready' && state.truncated)) && <div className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground" role="status">
        {state?.status === 'error' && <p className="text-destructive">Choices could not be loaded: {state.error}</p>}
        {!items.length && state?.status !== 'error' && <p>{loading ? 'Loading choices…' : query ? 'No matching choices.' : 'No choices.'}</p>}
        {matches.length > RENDERED_CHOICES && <p>Showing {RENDERED_CHOICES} of {matches.length.toLocaleString()} matches. Search to narrow them.</p>}
        {state?.status === 'ready' && state.truncated && <p>Only the first {MAX_PARAMETER_OPTIONS.toLocaleString()} choices are offered.</p>}
      </div>}
    </PopoverContent>
  </Popover>;
}
