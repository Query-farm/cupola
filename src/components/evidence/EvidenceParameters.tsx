import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, Loader2, Plus, Trash2, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ParameterChoicePicker } from './ParameterChoicePicker';
import { EvidenceCodeEditor } from './EvidenceCodeEditor';
import { parameterDependencies } from '../../lib/evidence/parameter-graph';
import { waitForEngineReady } from '../../lib/shell-bridge';
import { ParameterChoicesLoader, resolveChoices } from '../../lib/evidence/parameter-choices';
import { currentValues, hasChoices, type ParameterOption, type ParameterOptionsState } from '../../lib/evidence/parameters';
import { PARAMETER_TYPES, type EvidenceDrillPath, type EvidenceParameter, type EvidenceReport, type ParameterValue, type ParameterValues } from '../../lib/evidence/reports';

type Value = ParameterValue;
export function ParameterInput({ parameter, value, onChange, label, disabled, choices }: {
  parameter: EvidenceParameter; value: Value; onChange: (value: Value) => void; label: string; disabled?: boolean; choices?: ParameterOptionsState;
}) {
  if (parameter.type === 'boolean') return <select aria-label={label} disabled={disabled} className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm" value={value === null ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? null : event.target.value === 'true')}>
    <option value="">Not set</option><option value="true">True</option><option value="false">False</option>
  </select>;
  if (parameter.type === 'select' || parameter.type === 'multi_select') {
    const state = choices ?? (parameter.options?.kind === 'static' ? { status: 'static' as const, options: parameter.options.values } : undefined);
    return <ParameterChoicePicker parameter={parameter} value={value} onChange={onChange} label={label} disabled={disabled} state={state} />;
  }
  if (parameter.type === 'date_range') {
    const range = value && typeof value === 'object' && !Array.isArray(value) ? value : { start: null, end: null };
    const set = (part: 'start' | 'end', next: string) => onChange({ ...range, [part]: next || null });
    return <div className="flex items-center gap-1">
      <Input aria-label={`${label} from`} disabled={disabled} type="date" value={range.start ?? ''} max={range.end ?? undefined} onChange={event => set('start', event.target.value)} />
      <span className="text-muted-foreground" aria-hidden>–</span>
      <Input aria-label={`${label} to`} disabled={disabled} type="date" value={range.end ?? ''} min={range.start ?? undefined} onChange={event => set('end', event.target.value)} />
    </div>;
  }
  const scalar = Array.isArray(value) || (value !== null && typeof value === 'object') ? '' : value;
  return <Input aria-label={label} disabled={disabled} type={parameter.type === 'text' ? 'text' : parameter.type} step={parameter.type === 'number' ? 'any' : undefined} value={scalar == null ? '' : String(scalar)} onChange={event => onChange(parameter.type === 'number' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value)} />;
}

/** Keep every select / multi-select's choices current as the values they depend on change.
 *  `values` is the fitted set the parameter bar shows; explicit reader values that stop being
 *  a choice are handed to `onReset` (just those keys) so the report stops storing them. */
export function useParameterChoices(parameters: EvidenceParameter[], explicit: ParameterValues, enabled: boolean, onReset: (values: ParameterValues) => void) {
  const loader = useMemo(() => new ParameterChoicesLoader(), []);
  const [states, setStates] = useState<Record<string, ParameterOptionsState>>({});
  const [fitted, setFitted] = useState<ParameterValues | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const statesRef = useRef(states); statesRef.current = states;
  const resetRef = useRef(onReset); resetRef.current = onReset;
  const signature = JSON.stringify([parameters, explicit]);
  useEffect(() => {
    if (!enabled || !parameters.some(parameter => parameter.options)) { setStates({}); setFitted(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => void (async () => {
      try {
        await waitForEngineReady();
        const result = await resolveChoices(parameters, explicit, loader, { signal: controller.signal, previous: statesRef.current, onState: next => { if (!controller.signal.aborted) setStates(next); } });
        if (controller.signal.aborted) return;
        setFitted(result.values);
        if (result.notes.length) setNotes(result.notes);
        const resets = Object.fromEntries(Object.keys(explicit).filter(key => key in result.values && JSON.stringify(result.values[key]) !== JSON.stringify(explicit[key])).map(key => [key, result.values[key]]));
        if (Object.keys(resets).length) resetRef.current(resets);
      } catch { /* Superseded, or the engine never became ready: the next change retries. */ }
    })(), 150);
    return () => { controller.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled, loader]);
  // What the reader set shows at once; fitted values (defaults, "first") fill the rest.
  const values = { ...currentValues(parameters, explicit), ...Object.fromEntries(Object.entries(fitted ?? {}).filter(([key]) => !Object.hasOwn(explicit, key))) };
  return { loader, states, values, notes, clearNotes: () => setNotes([]) };
}

/** Choices as the editor sees them: live states from the parameter bar, and the loader to preview with. */
export interface ParameterChoicesContext { states: Record<string, ParameterOptionsState>; values: ParameterValues; loader: ParameterChoicesLoader }

const TYPE_LABELS: Record<EvidenceParameter['type'], string> = {
  text: 'Text', number: 'Number', date: 'Date', boolean: 'Boolean', select: 'Single choice', multi_select: 'Multiple choice', date_range: 'Date range',
};
function emptyValue(type: EvidenceParameter['type']): ParameterValue {
  if (type === 'multi_select') return [];
  if (type === 'date_range') return { start: null, end: null };
  if (type === 'boolean') return false;
  if (type === 'number') return 0;
  return type === 'select' ? null : '';
}
const staticText = (values: ParameterOption[]) => values.map(option => String(option.value) === option.label ? option.label : `${option.value} | ${option.label}`).join('\n');
function parseStatic(text: string): ParameterOption[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [value, ...label] = line.split('|');
    return { value: value.trim(), label: (label.join('|').trim() || value.trim()) };
  });
}

export function EvidenceParameters({ report, onChange, choices }: { report: EvidenceReport; onChange: (report: EvidenceReport) => void; choices?: ParameterChoicesContext }) {
  function update(index: number, patch: Partial<EvidenceParameter>) {
    const values = { ...report.values };
    if ('key' in patch || 'type' in patch || 'defaultValue' in patch || 'options' in patch) delete values[report.parameters[index].key];
    const renamed = 'key' in patch ? { from: report.parameters[index].key, to: patch.key! } : null;
    onChange({
      ...report, values,
      parameters: report.parameters.map((parameter, i) => i === index ? { ...parameter, ...patch } : parameter),
      // A renamed parameter keeps its place in drill paths.
      drillPaths: renamed ? report.drillPaths?.map(path => ({ ...path, levels: path.levels.map(level => level === renamed.from ? renamed.to : level) })) : report.drillPaths,
    });
  }
  const dependencies = useMemo(() => { try { return parameterDependencies(report); } catch { return new Map<string, string[]>(); } }, [report.parameters]);
  const labelOf = (key: string) => report.parameters.find(parameter => parameter.key === key)?.label ?? key;
  return <div className="space-y-6">
    <section className="space-y-3" aria-label="Parameter definitions">
      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Parameters</h3><Button variant="outline" size="sm" onClick={() => {
        let n = report.parameters.length + 1;
        while (report.parameters.some(p => p.key === `parameter_${n}`)) n++;
        onChange({ ...report, parameters: [...report.parameters, { id: crypto.randomUUID(), key: `parameter_${n}`, label: `Parameter ${n}`, type: 'text', required: false, defaultValue: '' }] });
      }}><Plus />Add parameter</Button></div>
      <p className="text-xs text-muted-foreground">Use <code>$city</code> in setup SQL, a SQL fence or another parameter's choices query; values are bound as prepared parameters, so don't quote the reference. <code>$city_all</code> is true when a choice is All or unset: <code>($city_all OR city = $city)</code>. A multiple choice is a list: <code>city IN ($city)</code>. Evidence components can filter on a parameter too: <code>filters=["city"]</code>.</p>
      {!report.parameters.length && <p className="text-xs text-muted-foreground">This report has no parameters.</p>}
      {report.parameters.map((parameter, index) => {
        const n = index + 1;
        const parents = dependencies.get(parameter.key) ?? [];
        const children = [...dependencies].filter(([key, keys]) => key !== parameter.key && keys.includes(parameter.key)).map(([key]) => key);
        return <fieldset key={parameter.id} className="space-y-3 rounded-lg border bg-background p-3">
          <legend className="px-1 text-xs text-muted-foreground">Parameter {n}</legend>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">Name<Input aria-label={`Parameter ${n} name`} value={parameter.key} onChange={e => update(index, { key: e.target.value })} /></label>
            <label className="space-y-1 text-xs">Label<Input aria-label={`Parameter ${n} label`} value={parameter.label} onChange={e => update(index, { label: e.target.value })} /></label>
            <label className="space-y-1 text-xs">Type<select aria-label={`Parameter ${n} type`} className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm" value={parameter.type} onChange={e => {
              const type = e.target.value as EvidenceParameter['type'];
              const choice = type === 'select' || type === 'multi_select';
              update(index, { type, defaultValue: emptyValue(type), options: choice ? parameter.options ?? { kind: 'static', values: [] } : undefined, allowAll: choice ? parameter.allowAll : undefined, defaultMode: choice ? parameter.defaultMode : undefined });
            }}>
              {PARAMETER_TYPES.map(type => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
            </select></label>
            <label className="space-y-1 text-xs">Default<ParameterInput parameter={parameter} value={parameter.defaultValue} choices={choices?.states[parameter.key]} onChange={defaultValue => update(index, { defaultValue })} label={`Parameter ${n} default`} /></label>
          </div>
          {hasChoices(parameter) && <ChoicesEditor n={n} parameter={parameter} choices={choices} report={report} onChange={patch => update(index, patch)} />}
          {parameter.type !== 'date_range' && <label className="block space-y-1 text-xs">Evidence filter column<Input aria-label={`Parameter ${n} filter column`} placeholder={parameter.key} value={parameter.filterColumn ?? ''} onChange={e => update(index, { filterColumn: e.target.value || undefined })} /><span className="text-muted-foreground">The column <code>filters=["{parameter.key}"]</code> compares with this value.</span></label>}
          {(parents.length > 0 || children.length > 0) && <p className="text-xs text-muted-foreground" aria-label={`Parameter ${n} dependencies`}>
            {parents.length > 0 && <>Choices depend on {parents.map(labelOf).join(', ')}. </>}
            {children.length > 0 && <>Changing it updates the choices of {children.map(labelOf).join(', ')}.</>}
          </p>}
          <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={parameter.required} onChange={e => update(index, { required: e.target.checked })} />Required</label><Button variant="ghost" size="sm" aria-label={`Remove parameter ${n}`} onClick={() => {
            const values = { ...report.values }; delete values[parameter.key];
            onChange({ ...report, values, parameters: report.parameters.filter((_, i) => i !== index), drillPaths: report.drillPaths?.map(path => ({ ...path, levels: path.levels.filter(level => level !== parameter.key) })).filter(path => path.levels.length) });
          }}><Trash2 />Remove</Button></div>
        </fieldset>;
      })}
    </section>
    <DrillPathsEditor report={report} onChange={onChange} />
  </div>;
}

function ChoicesEditor({ n, parameter, choices, report, onChange }: { n: number; parameter: EvidenceParameter; choices?: ParameterChoicesContext; report: EvidenceReport; onChange: (patch: Partial<EvidenceParameter>) => void }) {
  const options = parameter.options ?? { kind: 'static' as const, values: [] };
  const [preview, setPreview] = useState<{ status: 'loading' } | { status: 'done'; options: ParameterOption[]; truncated: boolean } | { status: 'error'; error: string } | null>(null);
  const [listText, setListText] = useState(() => options.kind === 'static' ? staticText(options.values) : '');
  async function runPreview() {
    if (!choices || options.kind !== 'query') return;
    setPreview({ status: 'loading' });
    try {
      await waitForEngineReady();
      const result = await choices.loader.load(parameter, report.parameters, choices.values);
      setPreview({ status: 'done', ...result });
    } catch (error) { setPreview({ status: 'error', error: error instanceof Error ? error.message : String(error) }); }
  }
  return <div className="space-y-3 rounded-md border border-dashed p-3">
    <div className="flex flex-wrap items-center gap-3 text-xs" role="radiogroup" aria-label={`Parameter ${n} choices from`}>
      <span className="font-medium">Choices</span>
      <label className="flex items-center gap-1"><input type="radio" checked={options.kind === 'static'} onChange={() => onChange({ options: { kind: 'static', values: parseStatic(listText) } })} />Listed</label>
      <label className="flex items-center gap-1"><input type="radio" checked={options.kind === 'query'} onChange={() => onChange({ options: { kind: 'query', sql: 'SELECT DISTINCT column AS value, column AS label FROM table ORDER BY label' } })} />From a query</label>
    </div>
    {options.kind === 'static'
      ? <label className="block space-y-1 text-xs">One per line: <code>value</code> or <code>value | label</code>
          <textarea aria-label={`Parameter ${n} choices`} className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" value={listText}
            onChange={e => { setListText(e.target.value); onChange({ options: { kind: 'static', values: parseStatic(e.target.value) } }); }} />
        </label>
      : <div className="space-y-2">
          <div className="h-32 overflow-hidden rounded-md border"><EvidenceCodeEditor language="data" ariaLabel={`Parameter ${n} choices query`} value={options.sql} onChange={sql => onChange({ options: { ...options, sql } })} parameters={report.parameters.filter(p => p.key !== parameter.key).map(p => p.key)} issues={[]} /></div>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">Value column<Input aria-label={`Parameter ${n} value column`} placeholder="value, or the first column" value={options.valueColumn ?? ''} onChange={e => onChange({ options: { ...options, valueColumn: e.target.value || undefined } })} /></label>
            <label className="space-y-1 text-xs">Label column<Input aria-label={`Parameter ${n} label column`} placeholder="label, or the second column" value={options.labelColumn ?? ''} onChange={e => onChange({ options: { ...options, labelColumn: e.target.value || undefined } })} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={!choices || preview?.status === 'loading'} onClick={() => void runPreview()}>{preview?.status === 'loading' ? <Loader2 className="animate-spin" /> : <Eye />}Preview choices</Button>
            {preview && preview.status !== 'loading' && <p role="status" aria-label={`Parameter ${n} choices preview`} className={`text-xs ${preview.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
              {preview.status === 'error' ? preview.error
                : preview.options.length ? `${preview.options.length.toLocaleString()}${preview.truncated ? '+' : ''} choices: ${preview.options.slice(0, 8).map(option => option.label).join(', ')}${preview.options.length > 8 ? ', …' : ''}`
                : 'The query returned no choices.'}
            </p>}
          </div>
        </div>}
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={`Parameter ${n} offers All`} checked={Boolean(parameter.allowAll)} onChange={e => onChange({ allowAll: e.target.checked || undefined })} />Offer “All”</label>
      <label className="space-y-1 text-xs">When unset or no longer a choice<select aria-label={`Parameter ${n} fallback`} className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm" value={parameter.defaultMode ?? 'value'} onChange={e => onChange({ defaultMode: e.target.value === 'value' ? undefined : e.target.value as EvidenceParameter['defaultMode'] })}>
        <option value="value">Use the default</option><option value="first">Use the first choice</option><option value="all">Use All</option><option value="none">Leave it empty</option>
      </select></label>
    </div>
  </div>;
}

function DrillPathsEditor({ report, onChange }: { report: EvidenceReport; onChange: (report: EvidenceReport) => void }) {
  const paths = report.drillPaths ?? [];
  const set = (next: EvidenceDrillPath[]) => onChange({ ...report, drillPaths: next.length ? next : undefined });
  const edit = (index: number, patch: Partial<EvidenceDrillPath>) => set(paths.map((path, i) => i === index ? { ...path, ...patch } : path));
  const candidates = report.parameters.filter(parameter => hasChoices(parameter) || parameter.type === 'text');
  return <section className="space-y-3" aria-label="Drill paths">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Drill paths</h3><Button variant="outline" size="sm" disabled={!candidates.length} onClick={() => set([...paths, { id: crypto.randomUUID(), label: 'All', levels: candidates.slice(0, 1).map(parameter => parameter.key) }])}><Plus />Add drill path</Button></div>
    <p className="text-xs text-muted-foreground">A drill path is an ordered chain of parameters, such as country → state → city. Readers click a chart bar or a matching table value to set the next level, and a breadcrumb above the report steps back up. Group your queries by the next unset level, for example <code>CASE WHEN $country_all THEN country WHEN $state_all THEN state ELSE city END</code>.</p>
    {!paths.length && <p className="text-xs text-muted-foreground">{candidates.length ? 'This report has no drill paths.' : 'Add a choice parameter to build a drill path.'}</p>}
    {paths.map((path, index) => <fieldset key={path.id} className="space-y-3 rounded-lg border bg-background p-3">
      <legend className="px-1 text-xs text-muted-foreground">Drill path {index + 1}</legend>
      <label className="block space-y-1 text-xs">First breadcrumb<Input aria-label={`Drill path ${index + 1} label`} placeholder="All" value={path.label ?? ''} onChange={e => edit(index, { label: e.target.value || undefined })} /></label>
      <ol className="space-y-2" aria-label={`Drill path ${index + 1} levels`}>
        {path.levels.map((level, position) => <li key={`${level}-${position}`} className="flex items-center gap-2 text-xs">
          <span className="w-5 text-right text-muted-foreground">{position + 1}.</span>
          <select aria-label={`Drill path ${index + 1} level ${position + 1}`} className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm" value={level}
            onChange={e => edit(index, { levels: path.levels.map((item, i) => i === position ? e.target.value : item) })}>
            {candidates.filter(parameter => parameter.key === level || !path.levels.includes(parameter.key)).map(parameter => <option key={parameter.key} value={parameter.key}>{parameter.label}</option>)}
          </select>
          <Button variant="ghost" size="icon" aria-label={`Move level ${position + 1} up`} disabled={position === 0} onClick={() => { const levels = [...path.levels]; [levels[position - 1], levels[position]] = [levels[position], levels[position - 1]]; edit(index, { levels }); }}><ArrowUp /></Button>
          <Button variant="ghost" size="icon" aria-label={`Move level ${position + 1} down`} disabled={position === path.levels.length - 1} onClick={() => { const levels = [...path.levels]; [levels[position + 1], levels[position]] = [levels[position], levels[position + 1]]; edit(index, { levels }); }}><ArrowDown /></Button>
          <Button variant="ghost" size="icon" aria-label={`Remove level ${position + 1}`} disabled={path.levels.length === 1} onClick={() => edit(index, { levels: path.levels.filter((_, i) => i !== position) })}><X /></Button>
        </li>)}
      </ol>
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" disabled={candidates.every(parameter => path.levels.includes(parameter.key))} onClick={() => {
          const next = candidates.find(parameter => !path.levels.includes(parameter.key));
          if (next) edit(index, { levels: [...path.levels, next.key] });
        }}><Plus />Add level</Button>
        <Button variant="ghost" size="sm" aria-label={`Remove drill path ${index + 1}`} onClick={() => set(paths.filter((_, i) => i !== index))}><Trash2 />Remove</Button>
      </div>
    </fieldset>)}
  </section>;
}
