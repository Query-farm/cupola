import { handlingOf, type CoverageEntry } from './components';
import { isChromatic, normalizeSvgColors, resolveColor } from './css-color';
import { normalizeInlines, ROW_GAP_PT, type Align, type Block, type Cell, type Graphic, type Inline, type LegendEntry } from './model';

/** Reads a rendered Evidence report into the print model.
 *
 * It walks the live DOM rather than the Markdoc tree: every value there is
 * already queried and formatted by Evidence, exactly as on screen, and the tree
 * cannot be paired with its output reliably (`data-component-id` is the tag's
 * source line and column, which two inline tags on one line share). The DOM also
 * reflects what the reader chose — the selected tab, the current table page.
 *
 * How each component is treated is declared in `components.ts`; every component
 * met on the way is recorded in `coverage`, which the catalog tests check. */

/** Re-renders a live ECharts instance as SVG at a print size; null if `el` has no chart. */
export type ChartRenderer = (el: HTMLElement, width: number, height: number) => string | null;
/** Captures custom HTML as a PNG at its on-screen size; null when it cannot. */
export type SnapshotRenderer = (el: HTMLElement, exclude: Element[], width: number) => Promise<{ png: Uint8Array; width: number; height: number } | null>;

export interface Extraction {
  blocks: Block[];
  files: Record<string, string | Uint8Array>;
  /** Components left out, by name, for the "Not included" notice. */
  omitted: string[];
  coverage: CoverageEntry[];
}

/** Hover cards and tooltips: their trigger is an icon, their content is not printed. */
const TOOLTIP_TRIGGER = '[aria-label="Toggle tooltip"], [data-slot="hover-card-trigger"], [data-slot="tooltip-trigger"], [data-slot="popover-trigger"]';
const SKIP = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'TEMPLATE', 'INPUT', 'SELECT', 'TEXTAREA', 'DIALOG', 'CANVAS', 'NOSCRIPT', 'IFRAME', 'AUDIO', 'VIDEO']);
const PX_PER_PT = 1 / 0.75;
const PRINT_DISPLAY = /^print:(block|flex|grid|inline|inline-block|inline-flex|table|contents)$/;
/** Evidence's three error markups: the block error panel (bad SQL, invalid
 * attribute), the inline "Error" badge (comparisons), and `role="alert"` text. */
const ERROR = '.text-destructive, [role="alert"]';

type TextStyle = Omit<Extract<Inline, { kind: 'text' }>, 'kind' | 'text'>;

/** Rows a paged table prints at most: Evidence's own line between tables it loads
 * whole (and pages in the browser) and tables it pages with a query per page. */
export const MAX_TABLE_ROWS = 2000;
/** Time one export may spend paging tables. A table Evidence pages by query costs a
 * query per page, so ten 10-row tables over 11k rows would otherwise mean 2,000
 * queries; past the budget a table prints what it has, and its note says so. */
export const PAGING_BUDGET_MS = 30_000;

export async function extractReport(root: Element, widthPx: number, renderChart: ChartRenderer, snapshot: SnapshotRenderer): Promise<Extraction> {
  const extractor = new Extractor(renderChart);
  await extractor.collectPagedTables(root);
  const blocks = extractor.blocks(root, widthPx);
  await extractor.captureSnapshots(snapshot);
  return { blocks, files: extractor.files, omitted: extractor.omitted, coverage: extractor.coverage };
}

class Extractor {
  files: Record<string, string | Uint8Array> = {};
  omitted: string[] = [];
  coverage: CoverageEntry[] = [];
  private consumed = new WeakSet<Element>();
  /** Inside a filled table cell every text color is meaningful (white on dark). */
  private keepTextColor = false;
  /** Every page's rows of each paged table, keyed by its component element. */
  private pagedRows = new Map<Element, { rows: Cell[][]; total: number; capped: boolean }>();
  private snapshots: { el: HTMLElement; exclude: Element[]; width: number; block: Extract<Block, { kind: 'image' }> }[] = [];
  private count = 0;
  constructor(private renderChart: ChartRenderer) {}

  private file(ext: string, content: string | Uint8Array): string {
    const path = `/assets/${++this.count}.${ext}`;
    this.files[path] = content;
    return path;
  }

  private record(render: string, outcome: CoverageEntry['outcome']) {
    this.coverage.push({ render, handling: handlingOf(render) ?? 'unclassified', outcome });
  }

  /** Hidden on screen, or by the report's print CSS. Tailwind's `print:` variants
   * are read from the class list: the screen's computed style cannot see them. */
  private hidden(el: Element): boolean {
    if (this.consumed.has(el) || SKIP.has(el.tagName) || el.hasAttribute('data-pdf-hidden') || el.getAttribute('role') === 'tooltip') return true;
    // An icon-only trigger (info) is chrome; one wrapping text (a truncated title) is content.
    if (el.matches(TOOLTIP_TRIGGER) && !el.textContent?.trim()) return true;
    if (el.classList.contains('print:hidden')) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none') return ![...el.classList].some(name => PRINT_DISPLAY.test(name));
    return style.visibility === 'hidden';
  }

  private inlineLevel(el: Element): boolean {
    const display = getComputedStyle(el).display;
    return display.startsWith('inline') || display === 'contents' && [...el.children].every(child => this.inlineLevel(child));
  }

  /** Block content of `el`: runs of inline content between blocks become paragraphs. */
  blocks(el: Element, width: number): Block[] {
    const out: Block[] = [];
    let run: Inline[] = [];
    const flush = () => {
      const children = normalizeInlines(run);
      if (children.length) out.push({ kind: 'paragraph', children });
      run = [];
    };
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { run.push({ kind: 'text', text: node.textContent ?? '' }); continue; }
      if (!(node instanceof Element)) continue;
      if (isDisclosure(node) && !this.consumed.has(node)) { flush(); out.push(this.disclosure(node)); continue; }
      if (this.hidden(node)) continue;
      if (this.inlineLevel(node) && node.tagName !== 'TABLE') { run.push(...this.inlineNode(node)); continue; }
      flush();
      // Print CSS page breaks: `{% page_break %}` is a bare `break-after-page` div.
      const style = getComputedStyle(node);
      if (style.breakBefore === 'page') out.push({ kind: 'pagebreak' });
      out.push(...this.block(node, width));
      if (style.breakAfter === 'page') out.push({ kind: 'pagebreak' });
    }
    flush();
    return out;
  }

  private block(el: Element, width: number): Block[] {
    const render = el.getAttribute('data-render');
    if (render) return this.component(el, render, width);
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const children = normalizeInlines(this.inlines(el));
      return children.length ? [{ kind: 'heading', level: Number(tag[1]), children }] : [];
    }
    if (tag === 'P') {
      const children = normalizeInlines(this.inlines(el));
      return children.length ? [{ kind: 'paragraph', children }] : [];
    }
    if (tag === 'UL' || tag === 'OL') {
      const items = [...el.children].filter(li => li.tagName === 'LI' && !this.hidden(li)).map(li => this.blocks(li, width));
      const start = Number(el.getAttribute('start')) || undefined;
      return items.length ? [{ kind: 'list', ordered: tag === 'OL', start, items }] : [];
    }
    if (tag === 'BLOCKQUOTE') return [{ kind: 'quote', blocks: this.blocks(el, width) }];
    if (tag === 'PRE') return [{ kind: 'code', text: el.textContent ?? '', lang: /language-(\S+)/.exec(el.querySelector('code')?.className ?? '')?.[1] }];
    if (tag === 'HR') return [{ kind: 'rule' }];
    if (tag === 'TABLE') return this.table(el, el);
    if (tag === 'IMG') return this.snapshot(el as HTMLElement, undefined, width);
    if (tag === 'svg') return [];
    const chart = el.hasAttribute('_echarts_instance_') ? el as HTMLElement : null;
    if (chart) return this.chart(el, chart, width);
    // `{% print_group %}` is a bare `break-inside-avoid` div: keep it on one page.
    if (getComputedStyle(el).breakInside === 'avoid') {
      const blocks = this.blocks(el, width);
      return blocks.length ? [{ kind: 'group', blocks }] : [];
    }
    return this.blocks(el, width);
  }

  private inlines(el: Element, style: TextStyle = {}): Inline[] {
    const out: Inline[] = [];
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        if (text) out.push({ kind: 'text', text, ...style, ...this.textColor(el), ...(style.bold || !isBold(el) ? {} : { bold: true }) });
      } else if (node instanceof Element) {
        out.push(...this.inlineNode(node, style));
      }
    }
    return out;
  }

  /** One element in running text. Inline components (value, delta, note…) arrive
   * here as their wrapper, so this is also where they are recorded. */
  private inlineNode(node: Element, style: TextStyle = {}): Inline[] {
    if (isDisclosure(node)) return this.inlines(node, style);
    if (this.hidden(node)) return [];
    const tag = node.tagName;
    const render = node.getAttribute('data-render');
    if (render) {
      const handling = handlingOf(render);
      const error = this.errorIn(node);
      if (error) { this.record(render, 'printed'); return [{ kind: 'text', text: error, bold: true, color: ERROR_COLOR }]; }
      if (handling === 'input' || handling === 'omitted') { this.skip(render, node); return []; }
      this.record(render, 'printed');
    }
    if (node.hasAttribute('_echarts_instance_')) { const graphic = this.inlineChart(node as HTMLElement); return graphic ? [graphic] : []; }
    if (tag === 'BR') return [{ kind: 'linebreak' }];
    if (tag === 'svg') { const icon = this.icon(node as SVGSVGElement); return icon ? [icon] : []; }
    if (tag === 'CODE') return [{ kind: 'text', text: node.textContent ?? '', ...style, code: true }];
    if (tag === 'A' && (node as HTMLAnchorElement).href) return [{ kind: 'link', href: (node as HTMLAnchorElement).href, children: this.inlines(node, style) }];
    if (tag === 'STRONG' || tag === 'B') return this.inlines(node, { ...style, bold: true });
    if (tag === 'EM' || tag === 'I') return this.inlines(node, { ...style, italic: true });
    if (tag === 'S' || tag === 'DEL') return this.inlines(node, { ...style, strike: true });
    if (tag === 'IMG') return [];
    return this.inlineElement(node, style);
  }

  /** An inline-block (every inline component's wrapper) lays out its own line
   * box, so whitespace at its edges is not rendered: `{% value %}.` has no space. */
  private inlineElement(el: Element, style: TextStyle = {}): Inline[] {
    const inlines = this.inlines(el, style);
    return /^inline-(block|flex|grid|table)$/.test(getComputedStyle(el).display) ? normalizeInlines(inlines) : inlines;
  }

  /** Keep only meaningful color: deltas' green/red and similar. Grays are theme text. */
  private textColor(el: Element): { color?: string } {
    if (el.closest('a, h1, h2, h3, h4, h5, h6')) return {};
    const color = resolveColor(getComputedStyle(el).color);
    return color && (this.keepTextColor || isChromatic(color)) ? { color } : {};
  }

  /** An inline SVG (a delta arrow, a `{% icon %}`) at its on-screen size. */
  private icon(svg: SVGSVGElement): Inline | null {
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(box.width));
    clone.setAttribute('height', String(box.height));
    const markup = normalizeSvgColors(new XMLSerializer().serializeToString(clone).replaceAll('currentColor', resolveColor(getComputedStyle(svg).color) ?? '#000'));
    return { kind: 'graphic', file: this.file('svg', markup), width: box.width, height: box.height };
  }

  /** A chart inside text or a table cell (a sparkline), kept at its on-screen size. */
  private inlineChart(el: HTMLElement): Inline | null {
    const box = el.getBoundingClientRect();
    const svg = box.width && box.height ? this.renderChart(el, Math.round(box.width), Math.round(box.height)) : null;
    return svg ? { kind: 'graphic', file: this.file('svg', svg), width: box.width, height: box.height } : null;
  }

  /** A section title from an expand/collapse trigger, which is a button the
   * walk otherwise skips. Collapsed content is not in the DOM, so say so. */
  private disclosure(button: Element): Block {
    this.consumed.add(button);
    // Its chevron is CSS-rotated, so the marker below says open or closed instead;
    // other icons in the title (a settings gear) are content.
    for (const chevron of button.querySelectorAll('svg[class*="chevron"]')) this.consumed.add(chevron);
    const title = normalizeInlines(this.inlines(button));
    const collapsed = button.getAttribute('aria-expanded') === 'false' || button.hasAttribute('data-collapsed');
    return { kind: 'paragraph', children: [
      { kind: 'text', text: collapsed ? '▸ ' : '▾ ' },
      ...title.map(inline => inline.kind === 'text' ? { ...inline, bold: true } : inline),
      ...(collapsed ? [{ kind: 'text' as const, text: '  (collapsed on screen, contents not included)', italic: true, color: '#6b6b5a' }] : []),
    ] };
  }

  private skip(render: string, el: Element) {
    const handling = handlingOf(render);
    this.record(render, handling === 'omitted' ? 'placeholder' : 'skipped');
    const title = el.getAttribute('data-component-title');
    this.omitted.push(title && handling === 'omitted' ? `${title} (${label(render)})` : label(render));
  }

  /** The message of an error this component shows itself (not one of a nested component's). */
  private errorIn(el: Element): string | null {
    const box = [...el.querySelectorAll(ERROR)].find(found => found.closest('[data-render]') === el && found.checkVisibility());
    if (!box) return null;
    // An inline badge's text is "Error" followed straight by its hidden detail.
    const text = box.textContent?.trim().replace(/\s+/g, ' ').replace(/^Error(?=[^\s:])/, 'Error: ');
    return text || 'This component failed to render.';
  }

  private omit(label: string): Block[] {
    this.omitted.push(label);
    return [{ kind: 'omitted', label: `${label} — not included in the PDF export` }];
  }

  /** The element holding a component's own content, inside its wrapper chrome. */
  private content(el: Element): Element {
    return el.querySelector(':scope [role="region"]') ?? el;
  }

  private component(el: Element, render: string, width: number): Block[] {
    const title = el.getAttribute('data-component-title') ?? undefined;
    const handling = handlingOf(render);
    // A failed component prints its error, even a control that would otherwise be skipped.
    const error = this.errorIn(el);
    if (error) {
      this.record(render, 'printed');
      return [...(title ? [{ kind: 'heading' as const, level: 4, children: [{ kind: 'text' as const, text: title }] }] : []), { kind: 'error', message: error }];
    }
    if (handling === 'input') { this.skip(render, el); return []; }
    if (handling === 'omitted') { this.record(render, 'placeholder'); return this.omit(title ? `${title} (${label(render)})` : label(render)); }
    const content = this.content(el);
    // Containers (tabs, details, accordions…) hold other components' charts and
    // tables; only one this component renders itself is its own.
    const own = <T extends Element>(found: T | null) => found?.closest('[data-render]') === el ? found : null;
    if (handling === 'snapshot') { this.record(render, 'printed'); return this.snapshot(content as HTMLElement, title, width); }
    this.record(render, 'printed');
    if (render === 'row') return this.row(content, width);
    if (render === 'callout') return this.callout(content, width);
    if (render === 'big_value') return this.metric(content, title);
    if (render === 'details') return this.details(content, width);
    if (render === 'tabs') return [...this.tabStrip(content), ...this.blocks(content, width)];
    if (render === 'table') {
      const table = own(content.querySelector('table'));
      return table ? this.table(table, content, title) : this.blocks(content, width);
    }
    const chart = own(content.querySelector<HTMLElement>('[_echarts_instance_]'));
    if (chart) return this.chart(content, chart, width, title);
    return this.blocks(content, width);
  }

  /** Components laid out side by side: each nested component nearest the row.
   * Inputs are removed before the width is shared, or their slot stays empty and
   * the charts beside them print stretched. */
  private row(content: Element, width: number): Block[] {
    const children = [...content.querySelectorAll('[data-render]')].filter(child =>
      !this.hidden(child) && child.parentElement?.closest('[data-render]') === content.closest('[data-render]'));
    const printable = children.filter(child => {
      const render = child.getAttribute('data-render')!;
      if (handlingOf(render) !== 'input') return true;
      this.skip(render, child);
      return false;
    });
    if (!children.length) return this.blocks(content, width);
    if (!printable.length) return [];
    const share = (width - (printable.length - 1) * ROW_GAP_PT * PX_PER_PT) / printable.length;
    const items = printable.map(child => this.block(child, share)).filter(blocks => blocks.length);
    if (items.length === 1) return items[0];
    return items.length ? [{ kind: 'row', items }] : [];
  }

  private callout(content: Element, width: number): Block[] {
    const box = content.firstElementChild ?? content;
    const heading = box.querySelector('h1, h2, h3, h4, h5, h6');
    if (heading) this.consumed.add(heading);
    const style = getComputedStyle(box);
    const accent = [style.borderLeftColor, style.borderTopColor].map(resolveColor).find(Boolean) ?? undefined;
    return [{ kind: 'callout', color: accent, title: heading ? normalizeInlines(this.inlines(heading)) : undefined, blocks: this.blocks(box, width) }];
  }

  /** `{% details %}` renders its body only while open; its trigger is a plain button. */
  private details(content: Element, width: number): Block[] {
    const button = content.querySelector('button');
    if (!button) return this.blocks(content, width);
    const open = Boolean(button.nextElementSibling);
    if (!open) button.setAttribute('data-collapsed', '');
    const blocks = [this.disclosure(button), ...this.blocks(content, width)];
    button.removeAttribute('data-collapsed');
    return blocks;
  }

  /** Which tab prints, and which do not: only the selected tab is in the DOM. */
  private tabStrip(content: Element): Block[] {
    const tabs = [...content.querySelectorAll('[role="tab"]')].filter(tab => tab.closest('[data-render]') === content.closest('[data-render]'));
    if (tabs.length < 2) return [];
    const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('data-state') === 'active');
    const name = (tab: Element) => tab.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    const others = tabs.filter(tab => tab !== selected).map(name).filter(Boolean);
    return [{ kind: 'paragraph', children: [
      ...(selected ? [{ kind: 'text' as const, text: `Tab: ${name(selected)}`, bold: true }] : []),
      ...(others.length ? [{ kind: 'text' as const, text: `${selected ? '  ' : ''}(other tabs not shown: ${others.join(', ')})`, italic: true, color: '#6b6b5a' }] : []),
    ] }];
  }

  /** A component's title/subtitle block (Evidence's ComponentTitle), consumed so it is not repeated. */
  private heading(content: Element, title: string | undefined): { title?: string; subtitle?: string; container?: Element } {
    if (!title) return {};
    const label = [...content.querySelectorAll('span')].find(span => span.firstChild?.textContent?.trim() === title && !span.closest('table, button'));
    const container = label?.parentElement;
    if (!label || !container) return { title };
    this.consumed.add(container);
    const subtitle = container.querySelector(':scope > div')?.textContent?.trim();
    return { title, subtitle: subtitle || undefined, container };
  }

  private chart(content: Element, instance: HTMLElement, width: number, title?: string): Block[] {
    const { subtitle } = this.heading(content, title);
    const height = Math.max(120, instance.getBoundingClientRect().height || 300);
    const svg = this.renderChart(instance, Math.round(width), Math.round(height));
    if (!svg) return this.omit(title ?? 'Chart');
    const legend: LegendEntry[] = [];
    for (const button of content.querySelectorAll('button')) {
      if (button.contains(instance)) continue;
      const swatch = [...button.querySelectorAll('span')].map(span => resolveColor(getComputedStyle(span).backgroundColor)).find(Boolean);
      const label = button.textContent?.trim();
      if (swatch && label) legend.push({ label, color: swatch });
    }
    return [{ kind: 'chart', title, subtitle, legend: legend.length ? legend : undefined, graphic: { file: this.file('svg', svg), width, height } }];
  }

  /** Evidence's BigValue: a title, the value (with an optional sparkline chart), then a comparison. */
  private metric(content: Element, title?: string): Block[] {
    // BigValue always renders its title span (empty or not), so its root is the
    // first span with the title and value side by side.
    const root = [...content.querySelectorAll('span')].find(span => span.children.length >= 2);
    if (!root) return this.blocks(content, contentWidth(content));
    const [titlePart, valuePart, comparisonPart] = [...root.children];
    // Evidence titles an untitled big value itself ("Sum Total Sales"); only an
    // explicit title reaches data-component-title.
    title ??= titlePart?.textContent?.trim() || undefined;
    const valueSize = valuePart ? parseFloat(getComputedStyle(valuePart).fontSize) * 0.75 : undefined;
    let sparkline: Graphic | undefined;
    const spark = valuePart?.querySelector<HTMLElement>('[_echarts_instance_]');
    if (spark) {
      const box = spark.getBoundingClientRect();
      const svg = box.width && box.height ? this.renderChart(spark, Math.round(box.width), Math.round(box.height)) : null;
      if (svg) sparkline = { file: this.file('svg', svg), width: box.width, height: box.height };
      // The chart's own element holds no text, but its wrapper may hold tooltip text.
      this.consumed.add(spark.closest('span') ?? spark);
    }
    const value = valuePart ? normalizeInlines(this.inlines(valuePart)) : [];
    const comparison = comparisonPart && !this.hidden(comparisonPart) ? normalizeInlines(this.inlines(comparisonPart)) : [];
    return [{ kind: 'metric', title, value, comparison: comparison.length ? comparison : undefined, sparkline, valueSize }];
  }

  private tableRows(table: Element, section: string): Element[] {
    return [...table.querySelectorAll(`:scope > ${section} > tr`)].filter(tr => !this.hidden(tr));
  }

  private tableCells(table: Element, content: Element) {
    const surface = resolveColor(getComputedStyle(table).backgroundColor) ?? resolveColor(getComputedStyle(content).backgroundColor);
    return (tr: Element, body: boolean): Cell[] => [...tr.children].filter(cell => !this.hidden(cell)).map(cell => {
      const visuals = body ? cellVisuals(cell, surface) : {};
      // On a color-scale fill the screen picks each value's text color (white on
      // dark, dark on light), on whichever element holds the text: keep it, gray or not.
      this.keepTextColor = Boolean(visuals.fill);
      const children = normalizeInlines(this.inlines(cell));
      this.keepTextColor = false;
      return { children, colspan: Number(cell.getAttribute('colspan')) || undefined, rowspan: Number(cell.getAttribute('rowspan')) || undefined, align: alignment(cell), ...visuals };
    });
  }

  /** The rows on screen now, in body order. */
  private bodyCells(table: Element, content: Element): Cell[][] {
    const cells = this.tableCells(table, content);
    return [...this.tableRows(table, 'tbody'), ...this.tableRows(table, 'tfoot')].map(tr => cells(tr, true));
  }

  /** A paged table prints every row, not the page on screen: step through its own
   * pager (so every value keeps Evidence's formatting, fills and bars), collect each
   * page, then put the pager back where the reader left it. */
  async collectPagedTables(root: Element): Promise<void> {
    const budgetEnds = Date.now() + PAGING_BUDGET_MS;
    for (const component of root.querySelectorAll('[data-render="table"]')) {
      if (!component.checkVisibility()) continue;
      const button = (label: string) => [...component.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)].find(b => b.closest('[data-render]') === component);
      const [first, next] = [button('First page'), button('Next page')];
      const table = [...component.querySelectorAll('table')].find(t => t.closest('[data-render]') === component);
      if (!first || !next || !table) continue;
      const content = this.content(component);
      const counter = /of\s+([\d,]+)\s+rows/.exec(content.textContent ?? '');
      const total = counter ? Number(counter[1].replaceAll(',', '')) : 0;
      // "3 of 45": the page indicator, which is the truth about where the pager is.
      // (The buttons also go disabled while a query-paged table loads a page.)
      const position = () => {
        const text = [...content.querySelectorAll('span')].map(span => span.textContent ?? '').find(text => /^\s*[\d,]+\s+of\s+[\d,]+\s*$/.test(text)) ?? '';
        const match = /([\d,]+)\s+of\s+([\d,]+)/.exec(text);
        return match ? { page: Number(match[1].replaceAll(',', '')), of: Number(match[2].replaceAll(',', '')) } : { page: 1, of: 1 };
      };
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      /** Click, then wait for the pager to reach `page` and the rows to change. */
      const turn = async (to: HTMLButtonElement, page: number) => {
        const deadline = Date.now() + 15_000;
        while (to.disabled && Date.now() < deadline) await frame();
        const before = table.querySelector('tbody')?.textContent;
        to.click();
        // A query-paged table shows a skeleton of empty rows while the page loads:
        // wait for rows that are new, not blank, and unchanged for two frames.
        let settled = 0, last = '';
        while (Date.now() < deadline) {
          await frame();
          const rows = table.querySelector('tbody')?.textContent ?? '';
          const loaded = position().page === page && rows !== before && rows.trim() !== '';
          settled = loaded && rows === last ? settled + 1 : 0;
          last = rows;
          if (settled >= 2) return true;
        }
        return false;
      };
      const start = position();
      try {
        if (start.page !== 1 && !await turn(first, 1)) continue;
        const pages: Cell[][][] = [this.bodyCells(table, content)];
        let count = pages[0].length;
        while (position().page < position().of && count < MAX_TABLE_ROWS && Date.now() < budgetEnds && await turn(next, position().page + 1)) {
          pages.push(this.bodyCells(table, content));
          count += pages.at(-1)!.length;
        }
        // A total row Evidence repeats at the foot of every page prints once, at the end.
        const signature = (row: Cell[] | undefined) => JSON.stringify(row?.map(cell => cell.children));
        const repeatedFoot = pages.length > 1 && pages.every(rows => signature(rows.at(-1)) === signature(pages[0].at(-1)));
        const rows = pages.flatMap((rows, i) => repeatedFoot && i < pages.length - 1 ? rows.slice(0, -1) : rows);
        this.pagedRows.set(component, { rows: rows.slice(0, MAX_TABLE_ROWS), total, capped: rows.length < total || rows.length > MAX_TABLE_ROWS });
      } finally {
        // Back to the page the reader was on.
        if (position().page !== 1) await turn(first, 1);
        while (position().page < start.page && await turn(next, position().page + 1)) { /* stepping forward */ }
      }
    }
  }

  private table(table: Element, content: Element, title?: string): Block[] {
    const { subtitle } = this.heading(content, title);
    const cells = this.tableCells(table, content);
    const header = this.tableRows(table, 'thead').map(tr => cells(tr, false));
    const paged = this.pagedRows.get(content.closest('[data-render]') ?? content);
    const body = paged?.rows ?? this.bodyCells(table, content);
    // Direct children only: a markdown table without <thead>/<tbody>.
    if (!header.length && !body.length) body.push(...[...table.querySelectorAll(':scope > tr')].map(tr => cells(tr, true)));
    if (!header.length && !body.length) return [];
    // Column proportions from the screen, where Evidence tables fill the width.
    const widthRow = [...this.tableRows(table, 'thead'), ...this.tableRows(table, 'tbody')].find(tr => [...tr.children].every(cell => !(Number(cell.getAttribute('colspan')) > 1)));
    const widths = widthRow ? [...widthRow.children].filter(cell => !this.hidden(cell)).map(cell => Math.round(cell.getBoundingClientRect().width)) : undefined;
    // Every row prints; past the cap, say how many were left out.
    const note = paged?.capped ? `Showing the first ${paged.rows.length.toLocaleString('en-US')} of ${paged.total.toLocaleString('en-US')} rows.` : undefined;
    return [{ kind: 'table', title, subtitle, header, rows: body, note, widths: widths?.every(w => w > 0) ? widths : undefined }];
  }

  /** Queue custom HTML for capture; the image is filled in by `captureSnapshots`. */
  private snapshot(el: HTMLElement, title?: string, width = contentWidth(el)): Block[] {
    // The title prints as text; leave it out of the image.
    const { container } = this.heading(el, title);
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    const block: Extract<Block, { kind: 'image' }> = { kind: 'image', title, graphic: { file: '', width: box.width, height: box.height } };
    this.snapshots.push({ el, exclude: container ? [container] : [], width, block });
    return [block];
  }

  async captureSnapshots(render: SnapshotRenderer): Promise<void> {
    // One at a time: a capture may re-lay-out its element at print width.
    for (const { el, exclude, width, block } of this.snapshots) {
      const shot = await render(el, exclude, width).catch(() => null);
      if (shot) {
        block.graphic = { file: this.file('png', shot.png), width: shot.width, height: shot.height };
      } else {
        // Replace in place: the block is already in the tree.
        Object.assign(block, { kind: 'omitted', label: `${block.title ?? 'Graphic'} — could not be captured for the PDF export` });
        this.omitted.push(block.title ?? 'graphic');
      }
    }
  }
}

/** Buttons that open and close report sections (accordion items, `details`):
 * their titles are content. Popover and menu triggers also carry `aria-expanded`,
 * so only the collapsible primitives' own markers count. */
function isDisclosure(el: Element): boolean {
  return el.tagName === 'BUTTON' && Boolean(el.textContent?.trim())
    && (el.hasAttribute('data-accordion-trigger') || el.hasAttribute('data-collapsible-trigger') || el.hasAttribute('data-collapsed'));
}

/** A table cell's color scale fill and `viz="bar"` bar, from the rendered styles. */
function cellVisuals(cell: Element, surface: string | null): Pick<Cell, 'fill' | 'bar'> {
  const out: Pick<Cell, 'fill' | 'bar'> = {};
  // The cell's own background only: a viz="bar" cell's inner track is not a fill.
  const fill = resolveColor(getComputedStyle(cell).backgroundColor);
  if (fill && fill !== surface) out.fill = fill;
  const bar = [...cell.querySelectorAll<HTMLElement>('div')].find(el => getComputedStyle(el).position === 'absolute' && /%/.test(el.style.width));
  if (bar) {
    const color = resolveColor(getComputedStyle(bar).backgroundColor);
    if (color) out.bar = { left: (parseFloat(bar.style.left) || 0) / 100, width: parseFloat(bar.style.width) / 100, color };
  }
  return out;
}

const label = (render: string) => render.replaceAll('_', ' ');
const ERROR_COLOR = '#b42318';

/** Weight set by CSS (a table's total row, a callout title) rather than by <strong>. */
function isBold(el: Element): boolean {
  return Number(getComputedStyle(el).fontWeight) >= 600 && !el.closest('h1, h2, h3, h4, h5, h6');
}

function contentWidth(el: Element): number {
  return el.getBoundingClientRect().width || 600;
}

function alignment(cell: Element): Align | undefined {
  const align = getComputedStyle(cell).textAlign;
  if (align === 'right' || align === 'end') return 'right';
  if (align === 'center') return 'center';
  return undefined;
}
