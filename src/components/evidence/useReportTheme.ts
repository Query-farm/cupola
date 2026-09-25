import { useEffect, useMemo, useState } from 'react';
import { APP_THEME_TOKENS, buildReportTheme } from '../../lib/evidence/report-theme';
import type { ReportAppearance } from '../../lib/evidence/appearance';

function readAppTheme() {
  const css = getComputedStyle(document.documentElement);
  // Canvas resolves CSS colors (including oklch and color()) to hex for Core.
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const tokens: Record<string, string> = {};
  for (const name of APP_THEME_TOKENS) {
    const value = css.getPropertyValue(`--${name}`).trim();
    if (!value || !context) continue;
    context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
    tokens[name] = '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
  }
  return { dark: document.documentElement.classList.contains('dark'), tokens };
}
export function useReportTheme(appearance: ReportAppearance | undefined) {
  const [app, setApp] = useState(readAppTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setApp(readAppTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => buildReportTheme(appearance, app.dark, app.tokens), [appearance, app]);
}
