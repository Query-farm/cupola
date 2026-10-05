import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookProposalReview } from '../../src/components/notebooks/NotebookProposalReview';
import {
  newNotebook,
  newCell,
  defaultChart,
  saveNotebook,
  notebookSchema,
  type SqlCell,
  type Notebook,
} from '../../src/lib/notebooks/model';
import { notebookProposal } from '../../src/lib/notebooks/agent';
const review = (before: Notebook, after: Notebook) =>
  renderToStaticMarkup(createElement(NotebookProposalReview, { before, after }));

describe('notebook proposal review', () => {
  test('shows source additions and removals, omitting unchanged cells regardless of property order', () => {
    const before = newNotebook('a');
    const sql = { ...before.cells[0], source: 'select 1' } as SqlCell;
    before.cells = [sql, { ...newCell('markdown'), source: 'Unchanged prose' }];
    const unchanged = Object.fromEntries(
      Object.entries(before.cells[1]).reverse(),
    ) as (typeof before.cells)[1];
    const html = review(before, { ...before, cells: [{ ...sql, source: 'select 2' }, unchanged] });
    expect(html).toContain('1 changed cell');
    expect(html).toContain('− select 1');
    expect(html).toContain('+ select 2');
    expect(html).not.toContain('Unchanged prose');
  });
  test('shows chart configuration changes and deletions in readable language', () => {
    const before = newNotebook('a');
    const sql = before.cells[0] as SqlCell;
    sql.charts = [
      { ...defaultChart([]), title: 'Revenue', y: 'amount' },
      { ...defaultChart([]), title: 'Old chart' },
    ];
    const next = { ...sql, charts: [{ ...sql.charts[0], y: 'total', type: 'line' as const }] };
    const html = review(before, { ...before, cells: [next] });
    expect(html).toContain('Removed chart: Old chart');
    expect(html).toContain('Chart type: bar → line');
    expect(html).toContain('Y column: amount → total');
  });
  test('distinguishes inserting a cell from moving existing cells', () => {
    const before = newNotebook('a');
    before.cells.push({ ...newCell('markdown'), title: 'Notes' });
    const inserted = review(before, { ...before, cells: [newCell('markdown'), ...before.cells] });
    expect(inserted).not.toContain('Moved from');
    const moved = review(before, { ...before, cells: [...before.cells].reverse() });
    expect(moved).toContain('Moved from cell 1 to cell 2');
    expect(moved).toContain('Moved from cell 2 to cell 1');
  });
  test('proposal review preserves the original snapshot and presentation changes persist', () => {
    const before = newNotebook('a');
    const sql = before.cells[0] as SqlCell;
    const proposal = notebookProposal(
      before,
      {
        summary: 'Presentation',
        title: before.title,
        cells: [{ ...sql, codeHidden: true, outputHidden: true, outputHeight: 720 }],
      },
      'unrestricted-sql',
    );
    const html = review(proposal.before, proposal.document);
    expect(html).toContain('Code hidden: Yes');
    expect(html).toContain('Output hidden: Yes');
    expect(html).toContain('Output height: Default → 720');
    let saved = '';
    saveNotebook(proposal.document, {
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    } as Storage);
    expect(notebookSchema.parse(JSON.parse(saved)).cells[0]).toMatchObject({
      codeHidden: true,
      outputHidden: true,
      outputHeight: 720,
    });
    expect(proposal.before.cells[0]).not.toHaveProperty('codeHidden');
  });
});
