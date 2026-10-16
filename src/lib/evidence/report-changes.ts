/** Which parts of a report an edit changed, told from the rendered output: the blocks of the new
 *  render that no block of the previous one matches. Evidence gives rendered blocks no stable
 *  identity, so a block is compared by what it shows: its text and a coarse print of its charts. */

/** A changed block of the new render, as the agent card names it. */
export interface ReportChange { label: string; kind: 'new' | 'changed' }

/** What a refresh changed once it was on screen: the run's revision (the outlines belong to it). */
export interface RevealedChanges { revision: number; list: ReportChange[] }

/** The attribute that marks a changed block, holding its index in the change list. */
export const CHANGE_ATTRIBUTE = 'data-cupola-change';

/** The rendered report's top-level blocks: the children of Evidence's document element. */
export function reportBlocks(root: ParentNode): Element[] {
  const content = root.querySelector('[data-markdoc-content]');
  if (!content) return [];
  const container = content.children.length === 1 ? content.firstElementChild! : content;
  return [...container.children].filter(block => !(block instanceof HTMLStyleElement || block instanceof HTMLScriptElement) && (block.textContent?.trim() || block.querySelector('canvas, svg, img, table')));
}

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** A chart's pixels shrunk to 8×8 and quantized: enough to tell a re-sorted or restyled chart apart. */
function canvasPrint(canvas: HTMLCanvasElement): string {
  if (!canvas.width || !canvas.height) return '0';
  try {
    const small = document.createElement('canvas');
    small.width = small.height = 8;
    const context = small.getContext('2d');
    if (!context) return `${canvas.width}x${canvas.height}`;
    context.drawImage(canvas, 0, 0, 8, 8);
    return Array.from(context.getImageData(0, 0, 8, 8).data, value => value >> 5).join('');
  } catch { return `${canvas.width}x${canvas.height}`; }
}

export function blockSignature(block: Element): string {
  const charts = [...block.querySelectorAll('canvas')].map(canvasPrint).join('|');
  const vectors = [...block.querySelectorAll('svg')].map(svg => svg.childElementCount).join(',');
  return `${block.tagName}:${normalize(block.textContent)}#${charts}#${vectors}`;
}

/** What a reader would call a block: its heading or title, else what it is and the section it is in. */
export function blockLabel(block: Element, section = ''): string {
  const titled = block.querySelector('h1, h2, h3, h4, h5, h6, figcaption, [class*="title" i], [aria-label]');
  const title = normalize(titled?.getAttribute('aria-label') || titled?.textContent);
  if (title) return title.length > 48 ? `${title.slice(0, 47)}…` : title;
  if (/^H[1-6]$/.test(block.tagName)) return normalize(block.textContent).slice(0, 48) || 'Heading';
  const kind = block.querySelector('canvas, svg') ? 'Chart' : block.querySelector('table') ? 'Table' : '';
  if (kind) return section ? `${kind} in “${section}”` : kind;
  const text = normalize(block.textContent);
  return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : 'Section';
}

/** Each block with its label, a block without a title named by the heading above it. */
function labelled(blocks: Element[]) {
  let section = '';
  return blocks.map(block => {
    if (/^H[1-6]$/.test(block.tagName)) section = normalize(block.textContent).slice(0, 40);
    return { block, key: blockSignature(block), label: blockLabel(block, section) };
  });
}

/** Marks the blocks of `next` that `previous` has no match for, and lists them. Matching is a
 *  multiset of signatures, so a moved block is unchanged. An unmatched block is "changed" when an
 *  unmatched old block had its label, else "new". */
export function markReportChanges(previous: ParentNode, next: ParentNode): ReportChange[] {
  const before = labelled(reportBlocks(previous)), after = labelled(reportBlocks(next));
  if (!before.length || !after.length) return [];
  const unmatchedOld = new Map<string, Element[]>();
  for (const item of before) unmatchedOld.set(item.key, [...unmatchedOld.get(item.key) ?? [], item.block]);
  const unmatchedNew = after.filter(item => {
    item.block.removeAttribute(CHANGE_ATTRIBUTE); item.block.removeAttribute('data-cupola-change-kind');
    const olds = unmatchedOld.get(item.key);
    if (!olds?.length) return true;
    olds.shift();
    return false;
  });
  const oldLabels = new Map<string, number>();
  for (const item of before) if (unmatchedOld.get(item.key)?.includes(item.block)) oldLabels.set(item.label, (oldLabels.get(item.label) ?? 0) + 1);
  // A rewrite that touched nearly everything isn't worth outlining block by block.
  if (unmatchedNew.length > Math.max(6, after.length * 0.75)) return [];
  return unmatchedNew.map(({ block, label }, index) => {
    const old = oldLabels.get(label) ?? 0;
    if (old > 0) oldLabels.set(label, old - 1);
    const kind = old > 0 ? 'changed' as const : 'new' as const;
    block.setAttribute(CHANGE_ATTRIBUTE, String(index));
    block.setAttribute('data-cupola-change-kind', kind);
    return { label, kind };
  });
}

/** Replays a change's highlight (scrolling it into view first). False when it is no longer shown. */
export function showReportChange(root: ParentNode, index: number): boolean {
  const block = root.querySelector(`[${CHANGE_ATTRIBUTE}="${index}"]`);
  if (!(block instanceof HTMLElement)) return false;
  block.scrollIntoView({ block: 'center', behavior: 'smooth' });
  block.classList.remove('cupola-change-flash');
  void block.offsetWidth;
  block.classList.add('cupola-change-flash');
  return true;
}
