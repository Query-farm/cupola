import type { SnapshotRenderer } from './extract';
import type { PdfFont } from './load-compiler';

/** Capture custom HTML (maps, progress bars, heat grids, images) as PNG.
 *
 * html-to-image redraws the element inside an SVG `foreignObject`, which cannot
 * see the page's fonts, so the PDF's own fonts go in as embedded CSS: captured
 * text matches the rest of the document instead of falling back to a system face.
 * Maps work because Evidence creates them with `preserveDrawingBuffer`, which
 * lets their WebGL canvas be read. */
export async function loadSnapshotRenderer(fonts: PdfFont[]): Promise<SnapshotRenderer> {
  const { toCanvas } = await import('html-to-image');
  const fontEmbedCSS = fonts.map(fontFace).join('\n');
  return async (el, exclude, width) => {
    if (!el.getBoundingClientRect().width) return null;
    // Lay HTML out at the printed width first, so it wraps like a page rather than
    // shrinking a screen-wide capture to unreadable type. Canvas content (maps)
    // would have to re-render at the new size, so it is captured as it is.
    const reflow = !el.querySelector('canvas') && Math.abs(el.getBoundingClientRect().width - width) > 1;
    const previous = el.style.cssText;
    if (reflow) {
      el.style.width = `${width}px`;
      el.style.maxWidth = `${width}px`;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    let canvas: HTMLCanvasElement;
    try {
      canvas = await toCanvas(el, {
        pixelRatio: 2, fontEmbedCSS, cacheBust: false,
        filter: node => !(node instanceof Element && exclude.includes(node)),
      });
    } finally {
      if (reflow) el.style.cssText = previous;
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob || !canvas.width || !canvas.height) return null;
    return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width / 2, height: canvas.height / 2 };
  };
}

const WEIGHTS: Record<string, number> = { Regular: 400, Italic: 400, SemiBold: 600, Bold: 700 };

function fontFace({ file, bytes }: PdfFont): string {
  const [stem, cut] = file.replace(/\.ttf$/, '').split('-');
  const family = stem === 'JetBrainsMono' ? 'JetBrains Mono' : stem;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `@font-face { font-family: '${family}'; font-weight: ${WEIGHTS[cut] ?? 400}; font-style: ${cut === 'Italic' ? 'italic' : 'normal'}; src: url(data:font/ttf;base64,${btoa(binary)}) format('truetype'); }`;
}
