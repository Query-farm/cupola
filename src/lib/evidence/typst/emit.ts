import type { Block, Cell, Inline, ReportDocument } from './model';
import { REPORT_TEMPLATE, TEMPLATE_PATH } from './template';

/** Typst source for a report, plus the virtual files it reads.
 *
 * Every piece of report text reaches Typst as a string literal built by `lit()`,
 * never as markup. Report data is arbitrary (`#`, `*`, `$`, `]`, `@` are all
 * ordinary characters in a table cell), and one unescaped markup character would
 * change the document or fail the compile. Structure is emitted in code mode for
 * the same reason: it leaves no markup context for data to land in. */
export function emitTypst(doc: ReportDocument): { main: string; files: Record<string, string | Uint8Array> } {
  const theme = doc.theme;
  const main = [
    `#import "${TEMPLATE_PATH}": *`,
    `#show: report.with(`,
    `  title: ${lit(doc.title)},`,
    `  updated: ${doc.updated ? lit(doc.updated) : 'none'},`,
    `  meta: ${pairs(doc.meta)},`,
    `  filters: ${pairs(doc.filters ?? [])},`,
    `  appendix: ${array((doc.appendix ?? []).map(item => `(${lit(item.label)}, ${array(item.values.map(lit))})`))},`,
    `  theme: (heading: ${lit(theme.heading)}, body: ${lit(theme.body)}, accent: rgb(${lit(color(theme.accent))}), foreground: rgb(${lit(color(theme.foreground))}), muted: rgb(${lit(color(theme.muted))}), border: rgb(${lit(color(theme.border))}), paper: ${lit(theme.paper)}),`,
    `)`,
    '',
    ...doc.blocks.map(block => `#${blockExpr(block)}\n`),
  ].join('\n');
  return { main, files: { ...doc.files, [TEMPLATE_PATH]: REPORT_TEMPLATE } };
}

const pairs = (items: { label: string; value: string }[]) => array(items.map(item => `(${lit(item.label)}, ${lit(item.value)})`));

/** A Typst string literal. Safe for any input: Typst strings only interpret `\` and `"`. */
export function lit(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
    else out += char;
  }
  return out + '"';
}

/** Browsers report colors as `rgb()`/`rgba()`; Typst's `rgb()` wants hex. Anything
 * unrecognised falls back to black rather than reaching the compiler. */
export function color(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(trimmed)) return trimmed;
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(trimmed);
  if (!match) return '#000000';
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
  return `#${hex(+match[1])}${hex(+match[2])}${hex(+match[3])}${alpha < 1 ? hex(alpha * 255) : ''}`;
}

const SAFE_LINK = /^(https?:|mailto:)/i;

export function inlineExpr(inlines: Inline[]): string {
  const parts = inlines.map(inline => {
    switch (inline.kind) {
      case 'text': {
        let expr = inline.code ? `raw(${lit(inline.text)})` : `text(${lit(inline.text)})`;
        if (inline.bold) expr = `strong(${expr})`;
        if (inline.italic) expr = `emph(${expr})`;
        if (inline.strike) expr = `strike(${expr})`;
        if (inline.color) expr = `text(fill: rgb(${lit(color(inline.color))}), ${expr})`;
        return expr;
      }
      case 'link': {
        const body = inlineExpr(inline.children);
        return SAFE_LINK.test(inline.href) ? `link(${lit(inline.href)}, ${body})` : body;
      }
      case 'graphic': return `cupola-inline-graphic(${graphic(inline.file, inline.width, inline.height)})`;
      case 'linebreak': return 'linebreak()';
    }
  });
  if (!parts.length) return '[]';
  return parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`;
}

function blocksExpr(blocks: Block[]): string {
  if (!blocks.length) return '[]';
  if (blocks.length === 1) return blockExpr(blocks[0]);
  return `[\n${blocks.map(block => `#${blockExpr(block)}\n`).join('\n')}]`;
}

function cellExpr(cell: Cell): string {
  const args = [`body: ${inlineExpr(cell.children)}`];
  if (cell.colspan && cell.colspan > 1) args.push(`colspan: ${cell.colspan}`);
  if (cell.rowspan && cell.rowspan > 1) args.push(`rowspan: ${cell.rowspan}`);
  if (cell.align) args.push(`align: ${cell.align}`);
  if (cell.fill) args.push(`fill: rgb(${lit(color(cell.fill))})`);
  if (cell.bar) args.push(`bar: (left: ${round(clamp01(cell.bar.left))}, width: ${round(clamp01(cell.bar.width))}, color: rgb(${lit(color(cell.bar.color))}))`);
  return `(${args.join(', ')})`;
}

/** The text of a cell, for measuring. Graphics (icons) are ignored. */
function plainText(inlines: Inline[]): string {
  return inlines.map(inline => inline.kind === 'text' ? inline.text : inline.kind === 'link' ? plainText(inline.children) : inline.kind === 'linebreak' ? '\n' : '').join('');
}
/** The `n` longest strings (by characters) of a list, without duplicates. */
function longest(values: Iterable<string>, n: number): string[] {
  return [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length).slice(0, n);
}
/** Per column, the few strings that decide its width: the longest unbreakable words (a column
 *  never gets narrower than these), the longest whole lines (its width without wrapping), and
 *  the header's words and line (measured bold). Typst measures only these, in the real font:
 *  measuring every cell of a 2,000-row table would be slow, and a character count is too rough
 *  (a "1" is narrower than an "M"). Columns are counted from rows without spanning cells. */
function sizingExpr(block: Extract<Block, { kind: 'table' }>): string {
  const plain = (row: Cell[]) => row.every(cell => !(cell.colspan && cell.colspan > 1)) ? row.map(cell => plainText(cell.children)) : null;
  const body = block.rows.map(plain).filter((row): row is string[] => row !== null);
  const head = block.header.map(plain).filter((row): row is string[] => row !== null);
  const count = Math.max(0, ...[...head, ...body].map(row => row.length));
  if (!count) return 'none';
  const words = (text: string) => text.split(/\s+/);
  return array(Array.from({ length: count }, (_, i) => {
    const cells = body.map(row => row[i] ?? '');
    const headers = head.map(row => row[i] ?? '');
    return `(words: ${array(longest(cells.flatMap(words), 3).map(lit))}, lines: ${array(longest(cells.flatMap(text => text.split('\n')), 3).map(lit))}, head-words: ${array(longest(headers.flatMap(words), 2).map(lit))}, head: ${array(longest(headers, 1).map(lit))})`;
  }));
}

/** A Typst array literal; a one-element array needs its trailing comma. */
function array(items: string[]): string {
  return `(${items.join(', ')}${items.length === 1 ? ',' : ''})`;
}

const opt = (value: string | undefined) => value ? lit(value) : 'none';
const graphic = (file: string, width: number, height: number) => `(file: ${lit(file)}, width: ${round(width)}, height: ${round(height)})`;
const round = (n: number) => Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function blockExpr(block: Block): string {
  switch (block.kind) {
    case 'heading': return `heading(level: ${Math.min(6, Math.max(1, block.level))}, ${inlineExpr(block.children)})`;
    case 'paragraph': return `par(${inlineExpr(block.children)})`;
    case 'list': {
      const items = array(block.items.map(blocksExpr));
      return block.ordered ? `enum(start: ${block.start ?? 1}, ..${items})` : `list(..${items})`;
    }
    case 'quote': return `quote(block: true, ${blocksExpr(block.blocks)})`;
    case 'code': return `raw(${lit(block.text)}, block: true${block.lang ? `, lang: ${lit(block.lang)}` : ''})`;
    case 'rule': return 'cupola-rule()';
    case 'pagebreak': return 'pagebreak(weak: true)';
    case 'group': return `block(breakable: false, width: 100%, ${blocksExpr(block.blocks)})`;
    case 'row': return `cupola-row(${array(block.items.map(blocksExpr))})`;
    case 'callout': return `cupola-callout(color: ${block.color ? `rgb(${lit(color(block.color))})` : 'none'}, title: ${block.title ? inlineExpr(block.title) : 'none'}, ${blocksExpr(block.blocks)})`;
    case 'chart': return `cupola-chart(title: ${opt(block.title)}, subtitle: ${opt(block.subtitle)}, legend: ${array((block.legend ?? []).map(entry => `(${lit(entry.label)}, rgb(${lit(color(entry.color))}))`))}, ${graphic(block.graphic.file, block.graphic.width, block.graphic.height)})`;
    case 'metric': return `cupola-metric(title: ${opt(block.title)}, size: ${block.valueSize ? `${round(Math.min(40, Math.max(12, block.valueSize)))}pt` : 'none'}, value: ${inlineExpr(block.value)}, comparison: ${block.comparison?.length ? inlineExpr(block.comparison) : 'none'}, sparkline: ${block.sparkline ? graphic(block.sparkline.file, block.sparkline.width, block.sparkline.height) : 'none'})`;
    case 'table': return `cupola-table(title: ${opt(block.title)}, subtitle: ${opt(block.subtitle)}, note: ${opt(block.note)}, widths: ${block.widths ? array(block.widths.map(w => String(round(w)))) : 'none'}, sizing: ${sizingExpr(block)}, header: ${array(block.header.map(row => array(row.map(cellExpr))))}, rows: ${array(block.rows.map(row => array(row.map(cellExpr))))})`;
    case 'image': return `cupola-image(title: ${opt(block.title)}, ${graphic(block.graphic.file, block.graphic.width, block.graphic.height)})`;
    case 'error': return `cupola-error(${lit(block.message)})`;
    case 'omitted': return `cupola-omitted(${lit(block.label)})`;
  }
}
