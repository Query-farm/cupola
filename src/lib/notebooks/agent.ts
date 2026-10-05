import { z } from 'zod';
import { TOOLS, type Tool } from '../ai-agent';
import { cellSchema, notebookSchema, fingerprint, type Notebook } from './model';
import type { AIQueryMode } from '../ai/query-mode';

const editSchema = z
  .object({
    summary: z.string().trim().min(1).max(300),
    title: z.string().max(200),
    cells: z.array(cellSchema).max(200),
  })
  .strict();
export interface NotebookProposal {
  summary: string;
  base: string;
  document: Notebook;
}
export function notebookProposal(current: Notebook, input: unknown, mode: AIQueryMode): NotebookProposal {
  const edit = editSchema.parse(input);
  if (mode === 'semantic-only') {
    for (const cell of edit.cells) {
      if (
        cell.type === 'sql' &&
        !current.cells.some(
          (previous) => previous.id === cell.id && previous.type === 'sql' && previous.source === cell.source,
        )
      )
        throw new Error('Semantic-only mode does not allow the assistant to create or change raw SQL cells.');
    }
  }
  const document = notebookSchema.parse({
    ...current,
    title: edit.title,
    cells: edit.cells,
    updatedAt: Date.now(),
  });
  if (fingerprint(current) === fingerprint(document))
    throw new Error(
      'The proposed notebook contains no changes. Revise the proposal to include the requested edits.',
    );
  return { summary: edit.summary, base: fingerprint(current), document };
}
export function applyNotebookProposal(current: Notebook, proposal: NotebookProposal): Notebook {
  if (fingerprint(current) !== proposal.base)
    throw new Error('The notebook changed after this proposal. Ask the assistant to update its proposal.');
  return notebookSchema.parse(proposal.document);
}
export const NOTEBOOK_TOOLS: Tool[] = [
  ...TOOLS.filter((tool) =>
    [
      'run_sql',
      'read_query_results',
      'query_semantic_model',
      'list_catalogs',
      'list_tables',
      'list_categories',
      'describe_table',
      'describe_function',
    ].includes(tool.name),
  ),
  {
    name: 'get_notebook',
    description:
      'Read the current notebook, selected cell ID, result schemas and execution diagnostics. Output rows are not included.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'propose_notebook_edit',
    description:
      'Propose a complete replacement title and cells for review, without executing or applying it. Supply edit_json as JSON containing summary, title, cells; use the cell schema described in the system prompt. Preserve IDs and content of unchanged cells.',
    input_schema: {
      type: 'object',
      properties: { edit_json: { type: 'string' } },
      required: ['edit_json'],
      additionalProperties: false,
    },
  },
];
export const NOTEBOOK_PROMPT = `You help users author Cupola SQL notebooks. Read get_notebook before proposing edits; discover actual schemas with the data tools before writing SQL. Never invent tables or columns. Query tools are for read-only exploration. Notebook SQL cells are independent, each with one read query; they do not create named relations for other cells. Use fully qualified table names.
Use propose_notebook_edit to stage changes; the user must apply them. Never claim a proposal was applied, saved, or executed. Preserve unchanged cells and their IDs, ordering and chart definitions. Explain changes briefly. Do not put secrets or credentials in notebook content.
Cell JSON schema:
Markdown: {id:string,type:"markdown",title:string,source:string,collapsed:boolean}
SQL: {id:string,type:"sql",title:string,source:string,collapsed:boolean,charts:Chart[],outputHeight?:number}
Chart: {id:string,title:string,type:"bar"|"line"|"area"|"scatter"|"histogram",x:string,y:string,color:string,xType:"nominal"|"quantitative"|"temporal",sort:"ascending"|"descending",xTitle:string,yTitle:string,yFormat:string}
outputHeight is an optional saved table viewport height in pixels (integer 240–4000); preserve it when present. Use unique IDs for new cells and charts. Use empty strings for optional chart fields. Charts consume the parent SQL result, with no SQL execution or implicit aggregation. Except histograms (which bin/count x), Y must be numeric; aggregate in SQL. Chart previews are limited to 10000 returned rows. yFormat is a D3 number format like ,.2f. Limit 200 cells and 20 charts per SQL cell.
In semantic-only mode you may explain, change Markdown or charts and reorganize existing SQL cells, but must not create or modify raw SQL. Explain this limitation when necessary.`;
