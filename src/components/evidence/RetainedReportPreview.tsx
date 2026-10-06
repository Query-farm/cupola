import { useEffect, useRef } from 'react';

/** Copy already rendered output without keeping queries or interactive components alive. */
export function captureReportPreview(root: ShadowRoot): DocumentFragment {
  const copy = document.createDocumentFragment();
  for (const child of root.childNodes) copy.append(child.cloneNode(true));
  const originals = root.querySelectorAll('canvas');
  copy.querySelectorAll('canvas').forEach((canvas, index) => {
    const original = originals[index];
    if (original?.width && original.height) {
      try { canvas.getContext('2d')?.drawImage(original, 0, 0); } catch { /* Some GPU canvases cannot be copied. */ }
    }
  });
  // A retained preview must not start embedded runtimes or duplicate live IDs used by tests.
  copy.querySelectorAll('script, iframe, object, embed').forEach(element => {
    const placeholder = document.createElement('p');
    placeholder.textContent = 'Interactive content is available after a successful refresh.';
    element.replaceWith(placeholder);
  });
  copy.querySelectorAll('[data-testid]').forEach(element => element.removeAttribute('data-testid'));
  copy.querySelectorAll('button, input, select, textarea').forEach(element => element.setAttribute('disabled', ''));
  copy.querySelectorAll('a, [tabindex]').forEach(element => { element.removeAttribute('href'); element.setAttribute('tabindex', '-1'); });
  return copy;
}

export function RetainedReportPreview({ content }: { content: DocumentFragment }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    root.replaceChildren(content);
    return () => { content.append(...root.childNodes); };
  }, [content]);
  return <div ref={host} className="pointer-events-none" aria-label="Previous report results" data-testid="retained-report-preview" />;
}
