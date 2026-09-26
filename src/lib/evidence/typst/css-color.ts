/** Resolve any CSS color to `#rrggbb` / `#rrggbbaa` for Typst and its SVG renderer.
 *
 * The browser hands back colors Typst cannot read: Tailwind v4 tokens compute to
 * `oklch(…)`, and chroma.js (Evidence's chart colors) writes CSS Color 4's
 * `rgb(255 255 255 / 0.8)`, which Typst's SVG renderer silently paints black.
 * Painting one canvas pixel converts every syntax and color space to sRGB. */
let context: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, string | null>();

export function resolveColor(css: string): string | null {
  const key = css.trim();
  if (cache.has(key)) return cache.get(key)!;
  context ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  let result: string | null = null;
  if (context && key && CSS.supports('color', key)) {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = key;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    result = a === 0 ? null : `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ''}`;
  }
  cache.set(key, result);
  return result;
}

const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi;

/** Rewrite every functional color in SVG markup (attributes and inline styles) as hex. */
export function normalizeSvgColors(svg: string): string {
  return svg.replace(COLOR_FUNCTION, match => resolveColor(match) ?? 'none');
}

/** True for colors worth keeping on text: greens and reds, not the theme's grays.
 * Both tests matter: a near-black warm foreground (#211a12) has a high hue ratio
 * but almost no chroma, and a pale tint has chroma spread over a light base. */
export function isChromatic(hex: string | null): boolean {
  if (!hex) return false;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min >= 48 && (max - min) / max > 0.35;
}
