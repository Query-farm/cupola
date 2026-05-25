/* ── Chart export utilities ──
 *
 * Helpers for serializing a live Mosaic plot SVG to a file the user can
 * save. Mosaic / Observable Plot produces standards-compliant SVG with
 * inline `<style>` blocks for everything (no external stylesheets), so a
 * straightforward serialize + Blob + anchor-click path works in any
 * browser without extra dependencies.
 *
 * SVG export: round-trips the SVG element verbatim.
 * PNG export: rasterizes the SVG via canvas at an arbitrary scale.
 */

/** Trigger a browser file download for a Blob. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // `rel="noopener"` keeps the anchor honest with strict-origin sites; some
  // browsers refuse the `download` attribute otherwise.
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Detach on next tick so the click fully dispatches first.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

/**
 * Build a complete filename for a chart export. Slugifies the title, then
 * appends a short timestamp so successive downloads of the same chart don't
 * collide in the user's Downloads folder, then forces the correct
 * extension regardless of what the title contained.
 */
function buildFilename(title: string, ext: "svg" | "png"): string {
  const stem = title
    .toLowerCase()
    .replace(/\.(svg|png|jpe?g|gif|webp)$/i, "")  // strip user-supplied ext
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chart";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `${stem}-${stamp}.${ext}`;
}

/**
 * Prepare a clone of the SVG for standalone export. Adds the required
 * xmlns attributes (without them, the file won't open as image/svg+xml in
 * browsers) and bakes the live `color` value into the root so any
 * `fill="currentColor"` / `stroke="currentColor"` references Mosaic emits
 * resolve correctly when the SVG renders detached from the page.
 *
 * Without this, marks render black: `<img src="...svg">` has no parent
 * color context, so `currentColor` defaults to the user-agent default
 * (black). Setting `color` on the root via a `style` attribute is the
 * minimal fix.
 */
function prepareSvgForExport(svg: SVGElement): SVGElement {
  const clone = svg.cloneNode(true) as SVGElement;
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  if (!clone.getAttribute("xmlns:xlink")) {
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  }
  // Bake the resolved foreground color so currentColor references work
  // standalone. Read it from the live element so light/dark mode and any
  // theme override flow through.
  try {
    const liveColor = getComputedStyle(svg).color;
    if (liveColor && liveColor !== "rgb(0, 0, 0)") {
      const existing = clone.getAttribute("style") || "";
      clone.setAttribute("style", `${existing}; color: ${liveColor}`);
    }
  } catch {}
  return clone;
}

/** Find the first SVG element inside a container. */
export function findChartSvg(container: HTMLElement | null): SVGElement | null {
  if (!container) return null;
  return container.querySelector("svg") as SVGElement | null;
}

/** Download the SVG verbatim. */
export function downloadChartSVG(svg: SVGElement, title: string): void {
  const clone = prepareSvgForExport(svg);
  const xml = new XMLSerializer().serializeToString(clone);
  // Prepend an XML declaration so the file opens correctly when saved.
  const data = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  // Plain "image/svg+xml" — without ";charset=utf-8", which some browsers
  // strip the +xml part from when picking an extension hint, resulting in
  // .xml downloads instead of .svg.
  const blob = new Blob([data], { type: "image/svg+xml" });
  triggerDownload(blob, buildFilename(title, "svg"));
}

/**
 * Rasterize the SVG to a PNG at a given pixel-density multiplier.
 * Default `scale=2` produces a retina-quality export at the SVG's
 * intrinsic dimensions.
 */
export async function downloadChartPNG(
  svg: SVGElement,
  title: string,
  scale: number = 2,
): Promise<void> {
  const clone = prepareSvgForExport(svg);
  // Pull dimensions from width/height attrs first (Mosaic sets them);
  // fall back to viewBox; finally fall back to the rendered size.
  const widthAttr = Number(clone.getAttribute("width"));
  const heightAttr = Number(clone.getAttribute("height"));
  const vb = clone.getAttribute("viewBox")?.split(/\s+/).map(Number);
  const w = Number.isFinite(widthAttr) && widthAttr > 0
    ? widthAttr
    : (vb && vb.length === 4 ? vb[2] : svg.getBoundingClientRect().width);
  const h = Number.isFinite(heightAttr) && heightAttr > 0
    ? heightAttr
    : (vb && vb.length === 4 ? vb[3] : svg.getBoundingClientRect().height);

  const xml = new XMLSerializer().serializeToString(clone);
  // Same "image/svg+xml" without charset — see downloadChartSVG comment.
  const svgBlob = new Blob([xml], { type: "image/svg+xml" });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await loadImage(svgUrl);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    // White background — most charts assume a light backdrop. Without this
    // the PNG would be transparent, which usually breaks pasted previews.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    await new Promise<void>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) { reject(new Error("PNG encoding failed")); return; }
        triggerDownload(pngBlob, buildFilename(title, "png"));
        resolve();
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load SVG into Image"));
    img.src = src;
  });
}
