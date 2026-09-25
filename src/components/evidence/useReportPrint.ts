import { useEffect, type RefObject } from 'react';

const chartImages = new WeakMap<HTMLElement, HTMLCanvasElement>();

function copyChart(chart: HTMLElement): HTMLCanvasElement | undefined {
  const layers = [...chart.querySelectorAll<HTMLCanvasElement>('canvas:not([data-evidence-print-snapshot])')];
  if (!layers.length || !layers[0].width || !layers[0].height) return;
  const scale = window.devicePixelRatio || 1;
  // Use the bitmap's CSS size, since print media may already have narrowed its
  // container while the canvas still holds a full-width screen rendering.
  const width = parseFloat(layers[0].style.width) || layers[0].width / scale;
  const height = parseFloat(layers[0].style.height) || layers[0].height / scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(scale, scale);
  for (const layer of layers) {
    if (layer.width && layer.height) context.drawImage(layer, parseFloat(layer.style.left) || 0, parseFloat(layer.style.top) || 0,
      parseFloat(layer.style.width) || layer.width / scale,
      parseFloat(layer.style.height) || layer.height / scale);
  }
  return canvas;
}

/** Capture on a layout change before ECharts' ResizeObserver clears hidden
 * canvases. This preserves the last rendered chart in full-screen editor mode. */
export function preserveReportCharts(host: HTMLElement, root: ShadowRoot): () => void {
  const observer = new MutationObserver(() => {
    for (const chart of root.querySelectorAll<HTMLElement>('[data-echarts-ready="true"]')) {
      const canvas = copyChart(chart);
      if (canvas) chartImages.set(chart, canvas);
    }
  });
  for (let ancestor: HTMLElement | null = host; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  }
  return () => observer.disconnect();
}

/** Native print events also cover Cmd/Ctrl+P and the browser's Print menu. */
export function useReportPrint(workspace: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const path: HTMLElement[] = [];
    const snapshots: HTMLCanvasElement[] = [];
    let previousTitle: string | undefined;
    function cleanup() {
      for (const element of path.splice(0)) element.removeAttribute('data-evidence-print-path');
      for (const canvas of snapshots.splice(0)) {
        canvas.parentElement?.removeAttribute('data-evidence-print-chart');
        canvas.remove();
      }
      if (previousTitle !== undefined) document.title = previousTitle;
      previousTitle = undefined;
    }
    function prepare() {
      cleanup();
      const root = workspace.current;
      // Reports remain mounted behind other app tabs. Only print an active report.
      if (!enabled || !root) return;
      // Inspect app state rather than computed visibility: the legacy print CSS
      // hides the document before beforeprint in some browsers.
      for (let element: HTMLElement | null = root; element; element = element.parentElement) {
        if (element.hidden || element.style.visibility === 'hidden' || element.style.display === 'none') return;
      }
      const surface = root.querySelector<HTMLElement>('[data-testid="evidence-report-surface"]');
      if (!surface) return;
      previousTitle = document.title;
      document.title = surface.dataset.printTitle || previousTitle;

      // Freeze chart canvases at their screen dimensions before print reflows them.
      // A copied canvas avoids waiting for image decoding inside beforeprint.
      const shadow = surface.querySelector('[data-testid="evidence-preview"]')?.shadowRoot;
      for (const chart of shadow?.querySelectorAll<HTMLElement>('[data-echarts-ready="true"]') ?? []) {
        const canvas = copyChart(chart) ?? chartImages.get(chart);
        if (!canvas) continue;
        canvas.setAttribute('data-evidence-print-snapshot', '');
        chart.setAttribute('data-evidence-print-chart', '');
        chart.append(canvas);
        snapshots.push(canvas);
      }
      // Release every constrained ancestor, hiding its siblings without changing
      // their screen layout, editor state, or the report's current interactions.
      for (let element = surface.parentElement; element; element = element.parentElement) {
        element.setAttribute('data-evidence-print-path', '');
        path.push(element);
      }
    }
    window.addEventListener('beforeprint', prepare);
    window.addEventListener('afterprint', cleanup);
    return () => {
      cleanup();
      window.removeEventListener('beforeprint', prepare);
      window.removeEventListener('afterprint', cleanup);
    };
  }, [workspace, enabled]);
}
