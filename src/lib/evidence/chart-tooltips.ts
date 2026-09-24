import { getInstanceByDom } from 'echarts';

/** Evidence portals chart tooltips to document.body, outside the preview's
 * shadow root. Hiding/scrolling the report does not necessarily send mouseout. */
export function manageReportChartTooltips(host: HTMLElement, root: ShadowRoot): () => void {
  const dismiss = () => {
    for (const node of root.querySelectorAll<HTMLElement>('[_echarts_instance_]')) {
      const chart = getInstanceByDom(node);
      if (chart && !chart.isDisposed()) chart.dispatchAction({ type: 'hideTip' });
    }
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
  const visibility = () => { if (document.hidden) dismiss(); };
  const hidden = () => {
    if (!host.checkVisibility({ visibilityProperty: true })) dismiss();
  };
  // The app retains inactive tabs with visibility:hidden. Observe only this
  // preview's ancestors, not the whole document or ECharts' own style updates.
  const observer = new MutationObserver(hidden);
  for (let ancestor: HTMLElement | null = host; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  }
  root.addEventListener('scroll', dismiss, true);
  document.addEventListener('scroll', dismiss, true);
  host.addEventListener('pointerleave', dismiss);
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('keydown', keydown);
  return () => {
    dismiss();
    observer.disconnect();
    root.removeEventListener('scroll', dismiss, true);
    document.removeEventListener('scroll', dismiss, true);
    host.removeEventListener('pointerleave', dismiss);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('resize', dismiss);
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('keydown', keydown);
  };
}
