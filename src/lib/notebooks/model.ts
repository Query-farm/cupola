import { z } from 'zod';
import { legacyScopeFor } from '../workspace/legacy-scope';
import { notebookParameterSchema, parameterValueSchema, validateParameterValue } from './parameters';

const id = z.string().min(1).max(200);
export const chartSchema = z
  .object({
    id,
    title: z.string().max(200),
    type: z.enum(['bar', 'line', 'area', 'scatter', 'histogram']),
    x: z.string(),
    y: z.string(),
    color: z.string(),
    xType: z.enum(['nominal', 'quantitative', 'temporal']),
    sort: z.enum(['result', 'ascending', 'descending']),
    xTitle: z.string(),
    yTitle: z.string(),
    yFormat: z.string().max(50),
  })
  .strict();
const common = {
  id,
  title: z.string().max(200),
  source: z.string().max(500_000),
  collapsed: z.boolean(),
  codeHidden: z.boolean().optional(),
  outputHidden: z.boolean().optional(),
};
export const cellSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('markdown') }).strict(),
  z
    .object({
      ...common,
      type: z.literal('sql'),
      charts: z.array(chartSchema).max(20),
      outputHeight: z.number().int().min(240).max(4000).optional(),
    })
    .strict(),
]);
export const notebookSchema = z
  .object({
    version: z.literal(1),
    id,
    serviceUrl: z.string(),
    /** The workspace it is stored in (multi-catalog). Absent on a notebook saved
     *  before workspaces, which is stored under its service URL. */
    workspaceId: z.string().optional(),
    title: z.string().max(200),
    cells: z.array(cellSchema).max(200),
    parameters: z.array(notebookParameterSchema).max(50).optional(),
    values: z.record(z.string(), parameterValueSchema).optional(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const parameter of doc.parameters ?? []) {
      if (keys.has(parameter.key) || ids.has(parameter.id))
        ctx.addIssue({ code: 'custom', message: 'Parameter names and IDs must be unique.' });
      keys.add(parameter.key);
      ids.add(parameter.id);
      try {
        validateParameterValue(parameter, parameter.defaultValue, false);
        if (doc.values && Object.hasOwn(doc.values, parameter.key))
          validateParameterValue(parameter, doc.values[parameter.key], false);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: String(error) });
      }
      if (
        parameter.type === 'select' &&
        (!parameter.choices?.length || new Set(parameter.choices).size !== parameter.choices.length)
      )
        ctx.addIssue({ code: 'custom', message: `${parameter.label} needs distinct choices.` });
      if (parameter.type !== 'select' && parameter.choices?.length)
        ctx.addIssue({ code: 'custom', message: 'Only dropdown parameters have choices.' });
    }
    for (const key of Object.keys(doc.values ?? {}))
      if (!keys.has(key)) ctx.addIssue({ code: 'custom', message: `Unknown parameter value: ${key}` });
    for (const cell of doc.cells) {
      for (const value of [cell.id, ...(cell.type === 'sql' ? cell.charts.map((chart) => chart.id) : [])]) {
        if (ids.has(value))
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate cell or chart ID: ${value}`,
          });
        ids.add(value);
      }
    }
  });
export type Notebook = z.infer<typeof notebookSchema>;
export type NotebookCell = z.infer<typeof cellSchema>;
export type SqlCell = Extract<NotebookCell, { type: 'sql' }>;
export type NotebookChart = z.infer<typeof chartSchema>;
export const uid = () => crypto.randomUUID();
export function newCell(type: NotebookCell['type']): NotebookCell {
  const base = {
    id: uid(),
    title: type === 'sql' ? 'Query' : 'Notes',
    source: '',
    collapsed: false,
  };
  return type === 'sql' ? { ...base, type, charts: [] } : { ...base, type };
}
export function newNotebook(serviceUrl: string, workspaceId?: string): Notebook {
  return {
    version: 1,
    id: uid(),
    title: 'Untitled notebook',
    serviceUrl,
    ...(workspaceId ? { workspaceId } : {}),
    cells: [newCell('sql')],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
export function fingerprint(doc: Notebook): string {
  // Compare content, not the key order produced by imports or model responses.
  // Do not validate here: an in-progress editor value may exceed save limits.
  return JSON.stringify(
    [doc.id, doc.serviceUrl, doc.title, doc.cells, doc.parameters ?? [], doc.values ?? {}],
    (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
  );
}
export function duplicateCell(cell: NotebookCell): NotebookCell {
  return {
    ...cell,
    id: uid(),
    ...(cell.type === 'sql' ? { charts: cell.charts.map((chart) => ({ ...chart, id: uid() })) } : {}),
  };
}
export function defaultChart(
  columns: { name: string; numeric: boolean; temporal: boolean }[],
): NotebookChart {
  const x = columns.find((column) => !column.numeric) ?? columns[0];
  const y =
    columns.find((column) => column.numeric && column !== x) ?? columns.find((column) => column.numeric);
  return {
    id: uid(),
    title: 'New chart',
    type: 'bar',
    x: x?.name ?? '',
    y: y?.name ?? '',
    color: '',
    xType: x?.temporal ? 'temporal' : x?.numeric ? 'quantitative' : 'nominal',
    sort: 'result',
    xTitle: '',
    yTitle: '',
    yFormat: '',
  };
}

export const STORAGE_PREFIX = 'cupola.notebook.v1:';
export const NOTEBOOKS_CHANGED = 'cupola:notebooks-changed';
/** Notebooks are stored per scope, like Evidence reports: the workspace id, or
 *  for a notebook saved before workspaces, its service URL. A workspace scope
 *  also reads its legacy URL's notebooks, read-only (`legacy-scope.ts`); one is
 *  copied under the workspace the first time it is saved again. */
export function storageKey(scope: string, id: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(id)}`;
}
/** Where a notebook is stored. */
export function notebookScope(doc: Pick<Notebook, 'workspaceId' | 'serviceUrl'>): string {
  return doc.workspaceId || doc.serviceUrl;
}
export function saveNotebook(doc: Notebook, storage: Storage = localStorage): void {
  const key = storageKey(notebookScope(doc), doc.id);
  const value = JSON.stringify(notebookSchema.parse(doc));
  const changed = storage.getItem?.(key) !== value;
  storage.setItem(key, value);
  if (changed && typeof window !== 'undefined' && storage === window.localStorage)
    window.dispatchEvent(new Event(NOTEBOOKS_CHANGED));
}
export function listNotebooks(
  scope: string,
  storage: Storage = localStorage,
): { documents: Notebook[]; unreadable: number } {
  const documents = new Map<string, Notebook>();
  let unreadable = 0;
  const read = (from: string, adopt: (doc: Notebook) => Notebook) => {
    const prefix = storageKey(from, '');
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)!;
      if (!key.startsWith(prefix)) continue;
      try {
        const doc = notebookSchema.parse(JSON.parse(storage.getItem(key)!));
        if (notebookScope(doc) !== from || storageKey(from, doc.id) !== key)
          throw new Error('Notebook identity mismatch');
        documents.set(doc.id, adopt(doc));
      } catch {
        unreadable++;
      }
    }
  };
  // The pre-workspace copies first, so the workspace's own wins.
  const legacy = legacyScopeFor(scope);
  if (legacy) read(legacy, (doc) => ({ ...doc, workspaceId: scope }));
  read(scope, (doc) => doc);
  return {
    documents: [...documents.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    unreadable,
  };
}
/** Import into the current connection as a new document; never overwrite the source. */
export function importNotebook(text: string, serviceUrl: string, workspaceId?: string): Notebook {
  if (text.length > 5_000_000) throw new Error('Notebook files must be smaller than 5 MB.');
  const { workspaceId: _from, ...doc } = notebookSchema.parse(JSON.parse(text));
  return {
    ...doc,
    id: uid(),
    serviceUrl,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function deleteNotebook(scope: string, id: string, storage: Storage = localStorage): void {
  // Deleting is the reader's choice, so the pre-workspace copy goes too;
  // otherwise the fallback would bring the notebook back.
  const legacy = legacyScopeFor(scope);
  for (const s of legacy ? [scope, legacy] : [scope]) storage.removeItem(storageKey(s, id));
  if (typeof window !== 'undefined' && storage === window.localStorage)
    window.dispatchEvent(new Event(NOTEBOOKS_CHANGED));
}
