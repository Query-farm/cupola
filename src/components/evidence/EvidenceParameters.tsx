import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { EvidenceParameter, EvidenceReport } from '../../lib/evidence/reports';

type Value = EvidenceParameter['defaultValue'];
export function ParameterInput({ parameter, value, onChange, label, disabled }: {
  parameter: EvidenceParameter; value: Value; onChange: (value: Value) => void; label: string; disabled?: boolean;
}) {
  if (parameter.type === 'boolean') return <select aria-label={label} disabled={disabled} className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm" value={value === null ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? null : event.target.value === 'true')}>
    <option value="">Not set</option><option value="true">True</option><option value="false">False</option>
  </select>;
  return <Input aria-label={label} disabled={disabled} type={parameter.type === 'text' ? 'text' : parameter.type} step={parameter.type === 'number' ? 'any' : undefined} value={value == null ? '' : String(value)} onChange={event => onChange(parameter.type === 'number' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value)} />;
}
export function EvidenceParameters({ report, onChange }: { report: EvidenceReport; onChange: (report: EvidenceReport) => void }) {
  function update(index: number, patch: Partial<EvidenceParameter>) {
    const values = { ...report.values };
    if ('key' in patch || 'type' in patch || 'defaultValue' in patch) delete values[report.parameters[index].key];
    onChange({ ...report, values, parameters: report.parameters.map((parameter, i) => i === index ? { ...parameter, ...patch } : parameter) });
  }
  return <section className="space-y-3" aria-label="Parameter definitions">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Parameters</h3><Button variant="outline" size="sm" onClick={() => {
      let n = report.parameters.length + 1;
      while (report.parameters.some(p => p.key === `parameter_${n}`)) n++;
      onChange({ ...report, parameters: [...report.parameters, { id: crypto.randomUUID(), key: `parameter_${n}`, label: `Parameter ${n}`, type: 'text', required: false, defaultValue: '' }] });
    }}><Plus />Add parameter</Button></div>
    <p className="text-xs text-muted-foreground">Define inputs here, then use <code>$city</code> or another parameter name in dataset SQL or a SQL fence. Values are bound as prepared parameters. Do not put quotes around the reference.</p>
    {!report.parameters.length && <p className="text-xs text-muted-foreground">This report has no parameters.</p>}
    {report.parameters.map((parameter, index) => <fieldset key={parameter.id} className="space-y-3 rounded-lg border bg-background p-3">
      <legend className="px-1 text-xs text-muted-foreground">Parameter {index + 1}</legend>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs">Name<Input aria-label={`Parameter ${index + 1} name`} value={parameter.key} onChange={e => update(index, { key: e.target.value })} /></label>
        <label className="space-y-1 text-xs">Label<Input aria-label={`Parameter ${index + 1} label`} value={parameter.label} onChange={e => update(index, { label: e.target.value })} /></label>
        <label className="space-y-1 text-xs">Type<select aria-label={`Parameter ${index + 1} type`} className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm" value={parameter.type} onChange={e => update(index, { type: e.target.value as EvidenceParameter['type'], defaultValue: e.target.value === 'boolean' ? false : e.target.value === 'number' ? 0 : '' })}>
          <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Boolean</option>
        </select></label>
        <label className="space-y-1 text-xs">Default<ParameterInput parameter={parameter} value={parameter.defaultValue} onChange={defaultValue => update(index, { defaultValue })} label={`Parameter ${index + 1} default`} /></label>
      </div>
      <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={parameter.required} onChange={e => update(index, { required: e.target.checked })} />Required</label><Button variant="ghost" size="sm" aria-label={`Remove parameter ${index + 1}`} onClick={() => {
        const values = { ...report.values }; delete values[parameter.key];
        onChange({ ...report, values, parameters: report.parameters.filter((_, i) => i !== index) });
      }}><Trash2 />Remove</Button></div>
    </fieldset>)}
  </section>;
}
