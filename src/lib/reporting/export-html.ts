/** Standalone, script-free HTML from the same extracted document used by PDF. */
import type { Block, Cell, Graphic, Inline } from '../evidence/typst/model';
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const color = (value?: string) => value && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value : 'transparent';
export function reportHtml(title: string, blocks: Block[], files: Record<string, string | Uint8Array>): string {
  function graphic(value: Graphic, alt = ''): string {
    const file = files[value.file];
    if (file === undefined) throw new Error('A report graphic could not be exported.');
    const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file;
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const mime = value.file.endsWith('.svg') ? 'image/svg+xml' : value.file.endsWith('.jpg') || value.file.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    return `<img alt="${escape(alt)}" src="data:${mime};base64,${btoa(binary)}" width="${Math.max(1, Math.round(value.width))}" height="${Math.max(1, Math.round(value.height))}">`;
  }
  function inline(values: Inline[]): string {
    return values.map(value => {
      if (value.kind === 'linebreak') return '<br>';
      if (value.kind === 'graphic') return graphic(value);
      if (value.kind === 'link') {
        const content = inline(value.children);
        return /^(https?:|mailto:)/i.test(value.href) ? `<a rel="noreferrer" href="${escape(value.href)}">${content}</a>` : content;
      }
      let content = escape(value.text);
      if (value.code) content = `<code>${content}</code>`;
      if (value.bold) content = `<strong>${content}</strong>`;
      if (value.italic) content = `<em>${content}</em>`;
      if (value.strike) content = `<s>${content}</s>`;
      return content;
    }).join('');
  }
  const cells = (values: Cell[], tag: 'th' | 'td') => values.map(cell => {
    const align = cell.align === 'right' || cell.align === 'center' ? cell.align : 'left';
    const bar = cell.bar ? `<span class="bar" style="left:${Math.max(0, Math.min(1, cell.bar.left)) * 100}%;width:${Math.max(0, Math.min(1, cell.bar.width)) * 100}%;background:${color(cell.bar.color)}"></span>` : '';
    return `<${tag} colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" style="text-align:${align};background-color:${color(cell.fill)}">${bar}<span class="cell">${inline(cell.children)}</span></${tag}>`;
  }).join('');
  const render = (values: Block[]): string => values.map(block => {
    switch (block.kind) {
      case 'heading': return `<h${block.level}>${inline(block.children)}</h${block.level}>`;
      case 'paragraph': return `<p>${inline(block.children)}</p>`;
      case 'code': return `<pre><code>${escape(block.text)}</code></pre>`;
      case 'rule': return '<hr>';
      case 'pagebreak': return '<div class="pagebreak"></div>';
      case 'quote': return `<blockquote>${render(block.blocks)}</blockquote>`;
      case 'group': return `<section>${render(block.blocks)}</section>`;
      case 'row': return `<div class="row">${block.items.map(items => `<section>${render(items)}</section>`).join('')}</div>`;
      case 'list': return `<${block.ordered ? `ol start="${block.start ?? 1}"` : 'ul'}>${block.items.map(items => `<li>${render(items)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
      case 'callout': return `<aside>${block.title ? `<strong>${inline(block.title)}</strong>` : ''}${render(block.blocks)}</aside>`;
      case 'image': return `<figure>${block.title ? `<figcaption>${escape(block.title)}</figcaption>` : ''}${graphic(block.graphic, block.title)}</figure>`;
      case 'chart': return `<figure>${block.title ? `<figcaption>${escape(block.title)}</figcaption>` : ''}${block.subtitle ? `<p>${escape(block.subtitle)}</p>` : ''}${graphic(block.graphic, block.title)}${block.legend?.length ? `<div class="legend">${block.legend.map(item => `<span><i style="background:${color(item.color)}"></i>${escape(item.label)}</span>`).join('')}</div>` : ''}</figure>`;
      case 'metric': return `<section class="metric">${block.title ? `<h3>${escape(block.title)}</h3>` : ''}<p class="value">${inline(block.value)}</p>${block.comparison ? `<p>${inline(block.comparison)}</p>` : ''}${block.sparkline ? graphic(block.sparkline) : ''}</section>`;
      case 'table': return `<div class="table">${block.subtitle ? `<p>${escape(block.subtitle)}</p>` : ''}<table>${block.title ? `<caption>${escape(block.title)}</caption>` : ''}<thead>${block.header.map(row => `<tr>${cells(row, 'th')}</tr>`).join('')}</thead><tbody>${block.rows.map(row => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table>${block.note ? `<p>${escape(block.note)}</p>` : ''}</div>`;
      case 'error': throw new Error(block.message);
      case 'omitted': throw new Error(`This report component cannot be exported: ${block.label}`);
    }
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;color:#242321;background:white;max-width:1100px;margin:2rem auto;padding:0 1.5rem}h1,h2,h3{line-height:1.2}a{color:#285581}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:.5rem;text-align:left;vertical-align:top}th{background:#f5f5f5}caption,figcaption{font-weight:600;text-align:left}.table{overflow:auto}.row{display:flex;flex-wrap:wrap;gap:1.5rem}.row>section{flex:1;min-width:220px}pre,aside,blockquote{background:#f6f6f6;padding:1rem;overflow:auto}.value{font-size:2rem;margin:.25rem 0}.pagebreak{break-after:page}figure{margin:1rem 0}section,figure{break-inside:avoid}td,th{position:relative}.cell{position:relative}.bar{position:absolute;top:15%;height:70%;opacity:.3}.legend{display:flex;flex-wrap:wrap;gap:1rem}.legend i{display:inline-block;width:.8rem;height:.8rem;margin-right:.35rem}</style></head><body>${render(blocks)}</body></html>`;
}
