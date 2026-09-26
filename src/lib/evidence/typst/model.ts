/** A print-oriented document model for Evidence reports.
 *
 * The extractor (`extract.ts`) fills this from the rendered report DOM, where
 * every value is already queried and formatted by Evidence itself; the emitter
 * (`emit.ts`) turns it into Typst. Keeping the model plain data puts all Typst
 * syntax, and therefore all escaping, in one pure, unit-tested module. */

export type Inline =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; color?: string }
  | { kind: 'link'; href: string; children: Inline[] }
  /** An inline graphic (a delta arrow, an icon, a sparkline) at its on-screen size in
   * CSS pixels. `file` names an entry in `ReportDocument.files`. */
  | { kind: 'graphic'; file: string; width: number; height: number }
  | { kind: 'linebreak' };

export type Align = 'left' | 'center' | 'right';
export interface Cell {
  children: Inline[]; colspan?: number; rowspan?: number; align?: Align;
  /** Background from a color scale or conditional format, `#rrggbb[aa]`. */
  fill?: string;
  /** A `viz="bar"` bar: offset and length as fractions of the cell width. */
  bar?: { left: number; width: number; color: string };
}
export interface LegendEntry { label: string; color: string }
export interface Graphic { file: string; width: number; height: number }

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start?: number; items: Block[][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'rule' }
  | { kind: 'pagebreak' }
  /** Content that must not be split across pages (`print_group`). */
  | { kind: 'group'; blocks: Block[] }
  | { kind: 'row'; items: Block[][] }
  | { kind: 'callout'; color?: string; title?: Inline[]; blocks: Block[] }
  | { kind: 'chart'; title?: string; subtitle?: string; legend?: LegendEntry[]; graphic: Graphic }
  /** `valueSize` is the value's on-screen size in points (`text_size` changes it). */
  | { kind: 'metric'; title?: string; value: Inline[]; comparison?: Inline[]; sparkline?: Graphic; valueSize?: number }
  /** `widths`: on-screen column widths in pixels, printed as proportions of the page. */
  | { kind: 'table'; title?: string; subtitle?: string; header: Cell[][]; rows: Cell[][]; note?: string; widths?: number[] }
  /** Custom HTML captured as an image (maps, progress bars…), at its on-screen size in CSS pixels. */
  | { kind: 'image'; title?: string; graphic: Graphic }
  /** A component that failed on screen: the PDF says so rather than printing an empty frame. */
  | { kind: 'error'; message: string }
  /** A component the exporter cannot represent; shown so omissions are never silent. */
  | { kind: 'omitted'; label: string };

export type PdfFont = 'serif' | 'sans-serif' | 'mono';
export interface PdfTheme {
  heading: PdfFont;
  body: PdfFont;
  /** `#rrggbb` colors. */
  accent: string;
  foreground: string;
  muted: string;
  border: string;
  paper: 'us-letter' | 'a4';
}

export interface ReportDocument {
  title: string;
  /** Extra details listed after the content (e.g. "Sections" of a PDF per value). */
  meta: { label: string; value: string }[];
  /** When the report's data was refreshed, in full; in every page's footer and after the content. */
  updated?: string;
  /** Parameters and inputs in effect, printed as the header's Filters section. */
  filters?: { label: string; value: string }[];
  /** Lists too long for the header (a multi-select of many values), printed in full at the end. */
  appendix?: { label: string; values: string[] }[];
  theme: PdfTheme;
  blocks: Block[];
  /** Virtual files the Typst source references, keyed by absolute path (e.g. `/charts/1.svg`). */
  files: Record<string, string | Uint8Array>;
}

/** Content width in CSS pixels at 96dpi (1px = 0.75pt), minus the template's margins.
 * Charts are rendered at this size so their 12px labels land at a 9pt print size. */
export function contentWidthPx(paper: PdfTheme['paper']): number {
  const pageWidthPt = paper === 'a4' ? 595.28 : 612;
  return Math.floor((pageWidthPt - 2 * MARGIN_PT) / 0.75);
}
export const MARGIN_PT = 54;
/** Gap between `row` columns, in points; mirrored by the template. */
export const ROW_GAP_PT = 12;

/** Letter for the countries that use it, A4 everywhere else. */
export function defaultPaper(locale: string | undefined): PdfTheme['paper'] {
  const region = locale?.split(/[-_]/)[1]?.toUpperCase();
  return region && ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'PR'].includes(region) ? 'us-letter' : 'a4';
}

/** Apply HTML whitespace rules to a run of inlines: collapse runs of whitespace
 * (across node boundaries, too) and trim the run's ends. Code spans keep theirs. */
export function normalizeInlines(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  let lastSpace = true; // Leading whitespace at the start of a run is dropped.
  const push = (inline: Inline) => {
    if (inline.kind !== 'text' || inline.code) { out.push(inline); lastSpace = inline.kind === 'linebreak'; return; }
    let text = inline.text.replace(/\s+/g, ' ');
    if (lastSpace) text = text.replace(/^ /, '');
    if (!text) return;
    lastSpace = text.endsWith(' ');
    out.push({ ...inline, text });
  };
  for (const inline of inlines) {
    if (inline.kind === 'link') {
      const children = normalizeInlines(inline.children);
      if (children.length) { if (!lastSpace && startsWithSpace(inline.children)) push({ kind: 'text', text: ' ' }); out.push({ ...inline, children }); lastSpace = false; }
    } else push(inline);
  }
  // Trim trailing whitespace, including a space left before a line break.
  for (let i = out.length - 1; i >= 0; i--) {
    const inline = out[i];
    if (inline.kind !== 'text' || inline.code) break;
    const text = inline.text.replace(/ $/, '');
    if (text) { out[i] = { ...inline, text }; break; }
    out.splice(i, 1);
  }
  return out;
}

function startsWithSpace(inlines: Inline[]): boolean {
  const first = inlines[0];
  return first?.kind === 'text' && /^\s/.test(first.text);
}

export function inlineText(inlines: Inline[]): string {
  return inlines.map(inline => inline.kind === 'text' ? inline.text : inline.kind === 'link' ? inlineText(inline.children) : inline.kind === 'linebreak' ? '\n' : '').join('');
}

/** Reports usually open with `# Title`, which would repeat the PDF's own title block. */
export function dropRepeatedTitle(blocks: Block[], title: string): Block[] {
  const [first, ...rest] = blocks;
  const same = (a: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === title.trim().replace(/\s+/g, ' ').toLowerCase();
  return first?.kind === 'heading' && first.level === 1 && same(inlineText(first.children)) ? rest : blocks;
}
