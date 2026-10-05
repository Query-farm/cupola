import { z } from 'zod';

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
    sort: z.enum(['ascending', 'descending']),
    xTitle: z.string(),
    yTitle: z.string(),
    yFormat: z.string().max(50),
  })
  .strict();
const common = { id, title: z.string().max(200), source: z.string().max(500_000), collapsed: z.boolean() };
export const cellSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('markdown') }).strict(),
  z.object({ ...common, type: z.literal('sql'), charts: z.array(chartSchema).max(20) }).strict(),
]);
export const notebookSchema = z
  .object({
    version: z.literal(1),
    id,
    serviceUrl: z.string(),
    title: z.string().max(200),
    cells: z.array(cellSchema).max(200),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    for (const cell of doc.cells) {
      for (const value of [cell.id, ...(cell.type === 'sql' ? cell.charts.map((chart) => chart.id) : [])]) {
        if (ids.has(value)) ctx.addIssue({ code: 'custom', message: `Duplicate cell or chart ID: ${value}` });
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
  const base = { id: uid(), title: type === 'sql' ? 'Query' : 'Notes', source: '', collapsed: false };
  return type === 'sql' ? { ...base, type, charts: [] } : { ...base, type };
}
export function newNotebook(serviceUrl: string): Notebook {
  return {
    version: 1,
    id: uid(),
    title: 'Untitled notebook',
    serviceUrl,
    cells: [newCell('sql')],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
export function fingerprint(doc: Notebook): string {
  return JSON.stringify([doc.id, doc.serviceUrl, doc.title, doc.cells]);
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
    sort: 'ascending',
    xTitle: '',
    yTitle: '',
    yFormat: '',
  };
}

export const STORAGE_PREFIX = 'cupola.notebook.v1:';
export function storageKey(serviceUrl: string, id: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(serviceUrl)}:${encodeURIComponent(id)}`;
}
export function saveNotebook(doc: Notebook, storage: Storage = localStorage): void {
  storage.setItem(storageKey(doc.serviceUrl, doc.id), JSON.stringify(notebookSchema.parse(doc)));
}
export function listNotebooks(
  serviceUrl: string,
  storage: Storage = localStorage,
): { documents: Notebook[]; unreadable: number } {
  const documents: Notebook[] = [];
  let unreadable = 0;
  const prefix = storageKey(serviceUrl, '');
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (!key.startsWith(prefix)) continue;
    try {
      const doc = notebookSchema.parse(JSON.parse(storage.getItem(key)!));
      if (doc.serviceUrl !== serviceUrl || storageKey(serviceUrl, doc.id) !== key)
        throw new Error('Notebook identity mismatch');
      documents.push(doc);
    } catch {
      unreadable++;
    }
  }
  return { documents: documents.sort((a, b) => b.updatedAt - a.updatedAt), unreadable };
}
/** Import into the current connection as a new document; never overwrite the source. */
export function importNotebook(text: string, serviceUrl: string): Notebook {
  if (text.length > 5_000_000) throw new Error('Notebook files must be smaller than 5 MB.');
  const doc = notebookSchema.parse(JSON.parse(text));
  return { ...doc, id: uid(), serviceUrl, createdAt: Date.now(), updatedAt: Date.now() };
}
