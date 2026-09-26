import { test, expect } from '@playwright/test';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';

test.use({ viewport: { width: 1400, height: 1000 } });

// ECharts appends chart tooltips to <body>, outside the report's shadow root, so their
// layout comes from Cupola's own stylesheet (global.css). A missing gap utility once ran
// every label into its value ("Outdoors79k").
test('chart tooltips keep a clear gap between each label and its value', async ({ page }) => {
  test.setTimeout(120_000);
  const report = { version: 1, id: 'tooltips', title: 'Tooltips', serviceUrl: EVIDENCE_SERVICE_URL, setupSql: '', createdAt: 1, updatedAt: 1, parameters: [], values: {},
    source: '# Tooltips\n\n```sql m\nSELECT month, category, sum(revenue) AS revenue FROM geo.sales GROUP BY ALL ORDER BY month\n```\n\n{% line_chart data="m" x="month" y="revenue" series="category" /%}\n\n{% bar_chart data="m" x="category" y="sum(revenue)" /%}\n' };
  await page.addInitScript(([saved]) => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)); } catch { /* sandboxed frame */ }
  }, [report]);
  await page.goto(evidencePath('evidence?evidence_report=tooltips'));
  const document = page.getByTestId('evidence-panel').getByTestId('evidence-document');
  for (const kind of ['line_chart', 'bar_chart']) {
    const canvas = document.locator(`[data-render="${kind}"] canvas`).first();
    await expect(canvas).toBeVisible({ timeout: 90_000 });
    const box = (await canvas.boundingBox())!;
    await expect(async () => {
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
      const rows = await page.evaluate(() => {
        const tip = [...document.body.querySelectorAll<HTMLElement>(':scope > div[style*="z-index: 9999999"]')].find(el => el.offsetWidth > 0 && getComputedStyle(el).visibility !== 'hidden');
        const grid = tip?.querySelector('.grid');
        if (!tip || !grid) return null;
        const cells = [...grid.children] as HTMLElement[];
        const pairs = [];
        for (let i = 0; i + 1 < cells.length; i += 2) {
          const label = cells[i].lastElementChild!.getBoundingClientRect();
          const value = cells[i + 1].getBoundingClientRect();
          // The value is right-aligned: its text starts at the cell's right edge minus the text's width.
          pairs.push({ gap: value.right - measure(cells[i + 1]) - label.right, text: cells[i].textContent!.trim() + ' | ' + cells[i + 1].textContent!.trim() });
        }
        function measure(el: HTMLElement) { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().width; }
        return { pairs, font: getComputedStyle(tip).fontFamily };
      });
      expect(rows).not.toBeNull();
      expect(rows!.pairs.length).toBeGreaterThan(0);
      // The value's text starts at least 16px after its label ends.
      for (const pair of rows!.pairs) expect(pair.gap, pair.text).toBeGreaterThanOrEqual(16);
      expect(rows!.font).toContain('Noto Sans');
    }).toPass({ timeout: 20_000 });
    await page.mouse.move(0, 0);
  }
});
