import { readFileSync } from 'node:fs';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });

// PDF text streams are compressed, so the PDF itself is checked for structure and
// the content through `window.__cupolaPdfDebug`, which keeps the Typst source
// and virtual files the export compiled.
test('Evidence exports a typeset PDF of the rendered report', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript((serviceUrl) => {
    const report = {
      version: 1, id: 'pdf-check', title: 'PDF check report',
      serviceUrl,
      setupSql: '', createdAt: 1, updatedAt: 1,
      parameters: [{ id: 'region', key: 'region', label: 'Region', type: 'text', required: true, defaultValue: 'North & "South" #1' }],
      values: {},
      source: '# PDF check report\n\n## Sales overview\n\n'
        + '```sql sales\nSELECT range AS period, range * 10 AS revenue, CASE WHEN range % 2 = 0 THEN \'east\' ELSE \'west\' END AS region FROM range(1, 13)\n```\n\n'
        + '```sql trend\nSELECT (range % 6) + 1 AS month, CASE WHEN range < 6 THEN \'west\' ELSE \'east\' END AS region, range * 7 AS revenue FROM range(0, 12)\n```\n\n'
        // sum(BIGINT) is HUGEINT: it must print as a number, not its raw bytes.
        + 'Revenue totals {% value data="sales" value="sum(revenue)" fmt="#,##0" /%} with *emphasis* and a [source](https://example.com/a?b="c").\n\n'
        + '{% dropdown id="region_filter" data="sales" value_column="region" /%}\n\n'
        + '{% row %}\n{% big_value data="sales" value="sum(revenue)" title="Revenue" fmt="#,##0" /%}\n{% big_value data="sales" value="max(period)" title="Periods" /%}\n{% /row %}\n\n'
        + '{% callout type="info" title="Heads up" %}\nCallout body text.\n{% /callout %}\n\n'
        + '{% line_chart data="trend" x="month" y="sum(revenue)" series="region" title="Revenue by month" subtitle="Monthly" /%}\n\n'
        + '{% page_break /%}\n\n'
        + '{% tabs %}\n{% tab title="Chart" %}\n{% bar_chart data="sales" x="period" y="revenue" title="Sales chart" /%}\n{% /tab %}\n{% tab title="Other" %}\nHidden tab text.\n{% /tab %}\n{% /tabs %}\n\n'
        + '{% table data="sales" title="Sales details" %}\n{% dimension value="region" title="Region" /%}\n{% measure value="sum(revenue)" title="Revenue" fmt="#,##0" /%}\n{% /table %}\n',
    };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(report.serviceUrl)}:${report.id}`, JSON.stringify(report));
    (window as { __cupolaPdfDebug?: unknown }).__cupolaPdfDebug = true;
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence?evidence_report=pdf-check'));
  const panel = page.getByTestId('evidence-panel');
  const report = panel.getByTestId('evidence-document');
  await expect(report.locator('[data-echarts-ready="true"]')).toHaveCount(2, { timeout: 90_000 });
  await expect(report.locator('[data-render="table"] tbody tr')).toHaveCount(3);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    panel.getByRole('button', { name: 'Export PDF', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('pdf-check-report.pdf');
  const path = testInfo.outputPath('report.pdf');
  await download.saveAs(path);
  const pdf = readFileSync(path).toString('latin1');
  expect(pdf.startsWith('%PDF-')).toBe(true);
  // The explicit page break forces a second page.
  expect(pdf.match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  // Progress and the result are shown on the button, which then resets.
  // The dropdown's control is not drawn, but its value is listed, so nothing is "not included".
  await expect(panel.getByRole('button', { name: 'PDF exported', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Export PDF', exact: true })).toBeEnabled({ timeout: 12_000 });

  const { main, files } = await page.evaluate(() => (window as unknown as { __cupolaPdfDebug: { main: string; files: Record<string, string> } }).__cupolaPdfDebug);
  // The report's own "# PDF check report" is not repeated under the title block.
  // The report's own heading is printed; the title only names the document (no title block).
  expect(main.match(/PDF check report/g)).toHaveLength(2);
  expect(main).toContain('heading(level: 1, text("PDF check report"))');
  // Every parameter and input in effect is listed in the Filters section after the content.
  expect(main).toContain('filters: (("Region", "North & \\"South\\" #1"), ("Region filter", "All")),');
  expect(main).toContain('text("780")');
  expect(main).not.toMatch(/12,3,0/);
  expect(main).toContain('emph(text("emphasis"))');
  expect(main).toContain('link("https://example.com/a?b=%22c%22", text("source"))');
  // Printed at its on-screen size relative to body text.
  expect(main).toMatch(/cupola-metric\(title: "Revenue", size: [\d.]+pt, value: text\("780"\)/);
  expect(main).toContain('cupola-callout(');
  expect(main).toContain('cupola-chart(title: "Revenue by month", subtitle: "Monthly", legend: (("west", rgb(');
  expect(main).toContain('pagebreak(weak: true)');
  // Only the selected tab prints, and the tab strip itself does not.
  expect(main).toContain('cupola-chart(title: "Sales chart"');
  expect(main).not.toContain('Hidden tab text');
  expect(main).toMatch(/cupola-table\(title: "Sales details".*text\("west"\).*text\("east"\)/s);

  const charts = Object.entries(files).filter(([name, content]) => name.endsWith('.svg') && content.includes('<path'));
  expect(charts.length).toBeGreaterThanOrEqual(2);
  for (const [, svg] of charts) {
    // Typst's SVG renderer paints CSS Color 4 syntax black: every color must be hex.
    expect(svg).not.toMatch(/\b(rgba?|oklch|hsla?)\(/);
    expect(svg).not.toContain('Geist');
  }
  expect(errors).toEqual([]);
});
