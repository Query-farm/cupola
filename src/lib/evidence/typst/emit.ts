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

/** A figure: a number with its sign, currency, grouping and unit (`-$1,234.56`, `(1,234)`,
 *  `+12.5%`, `US$3.2M`, `1.5e-3`). Unicode line breaking allows a break between a minus sign
 *  and a currency symbol, so a figure in a narrow column printed as "-" over "$1,234". */
const FIGURE = /^[([]?[+\-\u2212]?(?:[A-Z]{0,3}[^\p{L}\p{N}\s]{0,2})?[+\-\u2212]?\p{N}[\p{N}.,'\u2019\u00a0\u202f]*(?:[eE][+\-\u2212]?\p{N}+)?(?:[%\u2030]|[^\p{L}\p{N}\s]{1,2}|[a-zA-Z]{1,2})?[)\]]?$/u;
/** A currency or unit written apart from its figure: `12,90 €`, `USD 1,234`, `12 %`. */
const SYMBOL = /^(?:[^\p{L}\p{N}\s]{1,3}|[A-Z]{3})$/u;
/** Text as the pieces a line may not break inside: each figure, with a currency or unit set
 *  apart from it by a space, is one piece; everything else is left to Typst. */
export function figureUnits(text: string): { text: string; figure: boolean }[] {
  const tokens = text.split(/([ \t\r\n]+)/);
  const out: { text: string; figure: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (!FIGURE.test(token)) { out.push({ text: token, figure: false }); continue; }
    let unit = token;
    // "USD 1,234": the symbol before it joins the figure.
    const last = out.at(-1), space = out.at(-2);
    if (last && !last.figure && /^ $/.test(last.text) && space && !space.figure && SYMBOL.test(space.text)) {
      out.splice(-2, 2);
      unit = `${space.text} ${unit}`;
    }
    // "12,90 €": so does the symbol after it.
    if (tokens[i + 1] === ' ' && tokens[i + 2] && SYMBOL.test(tokens[i + 2])) { unit = `${unit} ${tokens[i + 2]}`; i += 2; }
    out.push({ text: unit, figure: true });
  }
  // Adjacent plain pieces rejoin, so text without figures stays one run.
  return out.reduce<{ text: string; figure: boolean }[]>((merged, piece) => {
    const previous = merged.at(-1);
    if (previous && !previous.figure && !piece.figure) previous.text += piece.text;
    else merged.push({ ...piece });
    return merged;
  }, []);
}
/** Digits, grouping and a percent sign alone never break; a sign, currency, letter, bracket or
 *  space in a figure might. Only those figures are boxed, since a box also splits the PDF's text
 *  into separate runs. */
const BREAKABLE = /[^\p{N}.,'\u2019\u00a0\u202f%\u2030]/u;
/** A run of text, with each figure that could break boxed so no line breaks inside it. */
function textWithFigures(text: string): string {
  const units = figureUnits(text).map(unit => ({ ...unit, figure: unit.figure && BREAKABLE.test(unit.text) }));
  if (!units.some(unit => unit.figure)) return `text(${lit(text)})`;
  const merged = units.reduce<typeof units>((out, unit) => {
    const previous = out.at(-1);
    if (previous && !previous.figure && !unit.figure) previous.text += unit.text; else out.push({ ...unit });
    return out;
  }, []);
  const parts = merged.map(unit => unit.figure ? `box(text(${lit(unit.text)}))` : `text(${lit(unit.text)})`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`;
}

export function inlineExpr(inlines: Inline[]): string {
  const parts = inlines.map(inline => {
    switch (inline.kind) {
      case 'text': {
        let expr = inline.code ? `raw(${lit(inline.text)})` : textWithFigures(inline.text);
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
/** A cell whose text is all bold (a total row, by CSS or `<strong>`). */
function isBoldCell(cell: Cell): boolean {
  const texts = cell.children.filter((inline): inline is Extract<Inline, { kind: 'text' }> => inline.kind === 'text' && Boolean(inline.text.trim()));
  return texts.length > 0 && texts.every(inline => inline.bold);
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
  // The pieces a line can't break inside, as the emitter boxes them: a figure with its currency is one.
  const words = (text: string) => figureUnits(text).flatMap(unit => unit.figure ? [unit.text] : unit.text.split(/\s+/));
  // Bold cells (total rows) are measured bold: wider than the same figures in regular weight.
  const boldText = (row: Cell[], i: number) => row[i] && isBoldCell(row[i]) ? plainText(row[i].children) : '';
  const boldRows = block.rows.filter(row => row.every(cell => !(cell.colspan && cell.colspan > 1)));
  return array(Array.from({ length: count }, (_, i) => {
    const cells = body.map(row => row[i] ?? '');
    const headers = head.map(row => row[i] ?? '');
    const bold = boldRows.map(row => boldText(row, i));
    return `(words: ${array(longest(cells.flatMap(words), 3).map(lit))}, bold-words: ${array(longest(bold.flatMap(words), 2).map(lit))}, lines: ${array(longest(cells.flatMap(text => text.split('\n')), 3).map(lit))}, head-words: ${array(longest(headers.flatMap(words), 2).map(lit))}, head: ${array(longest(headers, 1).map(lit))})`;
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
