import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { notebookSchema, uid, type Notebook } from '../../lib/notebooks/model';
import {
  parameterValue,
  validateParameterValue,
  type NotebookParameter,
  type ParameterValue,
} from '../../lib/notebooks/parameters';

const labels = { text: 'Text', number: 'Number', date: 'Date', select: 'Dropdown', boolean: 'Checkbox' };
const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';
function ValueInput({
  parameter,
  value,
  onChange,
  label,
}: {
  parameter: NotebookParameter;
  value: ParameterValue;
  onChange: (value: ParameterValue) => void;
  label: string;
}) {
  if (parameter.type === 'boolean')
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
    );
  if (parameter.type === 'select')
    return (
      <select
        aria-label={label}
        className={selectClass}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Not set</option>
        {[...new Set(parameter.choices ?? [])].map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  return (
    <Input
      aria-label={label}
      type={parameter.type}
      step={parameter.type === 'number' ? 'any' : undefined}
      value={value === null ? '' : String(value)}
      onChange={(e) =>
        onChange(
          parameter.type === 'number'
            ? e.target.value === ''
              ? null
              : Number(e.target.value)
            : e.target.value,
        )
      }
    />
  );
}
type Draft = NotebookParameter & { choicesText: string };
export function NotebookParameters({
  document,
  onChange,
}: {
  document: Notebook;
  onChange: (doc: Notebook) => void;
}) {
  const parameters = document.parameters ?? [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [error, setError] = useState('');
  function configure() {
    setDraft(parameters.map((p) => ({ ...p, choicesText: (p.choices ?? []).join('\n') })));
    setError('');
    setOpen(true);
  }
  function patch(id: string, update: Partial<Draft>) {
    setDraft((previous) => previous.map((p) => (p.id === id ? { ...p, ...update } : p)));
    setError('');
  }
  return (
    <section
      aria-label="Notebook parameters"
      className="mb-4 rounded-lg border border-border/60 p-3 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Parameters</span>
        <div className="flex gap-1">
          {!!Object.keys(document.values ?? {}).length && (
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...document, values: {} })}>
              Reset to defaults
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={configure}>
            {parameters.length ? 'Edit parameters' : 'Add parameters'}
          </Button>
        </div>
      </div>
      {!!parameters.length && (
        <>
          <div className="flex flex-wrap gap-4">
            {parameters.map((parameter) => {
              const value = parameterValue(parameter, document.values);
              let error = '';
              try {
                validateParameterValue(parameter, value);
              } catch (e) {
                error = e instanceof Error ? e.message : String(e);
              }
              return (
                <div key={parameter.id} className="min-w-36 max-w-sm space-y-1 text-xs">
                  <div>
                    {parameter.label}
                    {parameter.required ? ' *' : ''}{' '}
                    <code className="text-muted-foreground">${parameter.key}</code>
                  </div>
                  <ValueInput
                    parameter={parameter}
                    value={value}
                    label={parameter.label}
                    onChange={(next) =>
                      onChange({ ...document, values: { ...document.values, [parameter.key]: next } })
                    }
                  />
                  {error && (
                    <p className="text-destructive" role="status">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Values are saved with this notebook. Changing a value does not run SQL. Use Run changed to refresh
            affected cells.
          </p>
        </>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[90dvh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Notebook parameters</DialogTitle>
            <DialogDescription>
              Use unquoted references such as $region in SQL. Values are bound safely as query parameters.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto space-y-4">
            {draft.map((parameter, i) => (
              <fieldset key={parameter.id} className="rounded border p-3 space-y-3">
                <legend className="px-1 text-xs">Parameter {i + 1}</legend>
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-xs space-y-1">
                    Name
                    <Input
                      aria-label={`Parameter ${i + 1} name`}
                      value={parameter.key}
                      onChange={(e) => patch(parameter.id, { key: e.target.value })}
                    />
                  </label>
                  <label className="text-xs space-y-1">
                    Label
                    <Input
                      aria-label={`Parameter ${i + 1} label`}
                      value={parameter.label}
                      onChange={(e) => patch(parameter.id, { label: e.target.value })}
                    />
                  </label>
                  <label className="text-xs space-y-1">
                    Widget
                    <select
                      aria-label={`Parameter ${i + 1} widget`}
                      className={selectClass}
                      value={parameter.type}
                      onChange={(e) => {
                        const type = e.target.value as NotebookParameter['type'];
                        patch(parameter.id, {
                          type,
                          defaultValue: type === 'boolean' ? false : type === 'number' ? 0 : '',
                          choices: undefined,
                          choicesText: '',
                        });
                      }}
                    >
                      {Object.entries(labels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="text-xs space-y-1">
                    Default value
                    <ValueInput
                      parameter={{
                        ...parameter,
                        choices: parameter.choicesText
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      }}
                      value={parameter.defaultValue}
                      label={`Parameter ${i + 1} default`}
                      onChange={(defaultValue) => patch(parameter.id, { defaultValue })}
                    />
                  </div>
                </div>
                {parameter.type === 'select' && (
                  <label className="block text-xs space-y-1">
                    Choices (one per line)
                    <textarea
                      aria-label={`Parameter ${i + 1} choices`}
                      className="w-full min-h-24 rounded border bg-background p-2"
                      value={parameter.choicesText}
                      onChange={(e) => patch(parameter.id, { choicesText: e.target.value })}
                    />
                  </label>
                )}
                <div className="flex items-center justify-between">
                  <label className="text-xs flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={parameter.required}
                      onChange={(e) => patch(parameter.id, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraft((items) => items.filter((p) => p.id !== parameter.id))}
                  >
                    Remove parameter {i + 1}
                  </Button>
                </div>
              </fieldset>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={draft.length >= 50}
              onClick={() => {
                let n = draft.length + 1;
                while (draft.some((p) => p.key === `parameter_${n}`)) n++;
                setDraft([
                  ...draft,
                  {
                    id: uid(),
                    key: `parameter_${n}`,
                    label: `Parameter ${n}`,
                    type: 'text',
                    defaultValue: '',
                    required: false,
                    choicesText: '',
                  },
                ]);
              }}
            >
              Add parameter
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const next = draft.map(({ choicesText, ...p }) => ({
                  ...p,
                  choices:
                    p.type === 'select'
                      ? choicesText
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean)
                      : undefined,
                }));
                const values: Record<string, ParameterValue> = {};
                for (const p of next) {
                  if (
                    parameters.some((old) => old.id === p.id && old.key === p.key && old.type === p.type) &&
                    document.values &&
                    Object.hasOwn(document.values, p.key)
                  ) {
                    try {
                      validateParameterValue(p, document.values[p.key], false);
                      values[p.key] = document.values[p.key];
                    } catch {
                      /* Use the new default. */
                    }
                  }
                }
                const parsed = notebookSchema.safeParse({ ...document, parameters: next, values });
                if (!parsed.success) {
                  setError(parsed.error.issues[0].message);
                  return;
                }
                onChange(parsed.data);
                setOpen(false);
              }}
            >
              Save parameters
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
