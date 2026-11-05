import { test, expect } from '@playwright/test';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';

test.use({ viewport: { width: 1400, height: 1000 } });

// Evidence's html block routes link clicks to the page. An external host the block names opens a
// new tab; an unnamed one opens nothing. Reports have no sibling pages, so an internal path would
// be a 404 that takes the reader out of Cupola: goto refuses it and the report says so.
const SOURCE = `# Links

{% html %}
<p><a id="external" href="https://example.com/ticket/42">external</a></p>
<p><a id="internal" href="/somewhere/else">internal</a></p>
<p><button id="unnamed">unnamed</button></p>
<script>
  document.getElementById("unnamed").addEventListener("click", () => evidence.openUrl(["https:", "", "not-named.invalid", "x"].join("/")));
  evidence.ready();
</script>
{% /html %}
`;

test('html block links open named hosts and never leave Cupola', async ({ page }) => {
  test.setTimeout(120_000);
  const report = { version: 1, id: 'html-links', title: 'Links', serviceUrl: EVIDENCE_SERVICE_URL, setupSql: '', createdAt: 1, updatedAt: 1, parameters: [], values: {}, source: SOURCE };
  await page.addInitScript(saved => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)); } catch { /* sandboxed frame */ }
  }, report);
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>ticket</title>' }));
  await page.goto(evidencePath('evidence?evidence_report=html-links'));

  const panel = page.getByTestId('evidence-panel');
  const frame = panel.getByTestId('evidence-document').locator('[data-render=html] iframe').contentFrame();

  await expect(frame.locator('#external')).toBeVisible({ timeout: 90_000 });
  const [popup] = await Promise.all([page.waitForEvent('popup'), frame.locator('#external').click()]);
  expect(popup.url()).toBe('https://example.com/ticket/42');
  await popup.close();

  const popups: string[] = [];
  page.on('popup', opened => popups.push(opened.url()));
  await frame.locator('#unnamed').click();
  await page.waitForTimeout(1000);
  expect(popups).toEqual([]);

  const before = page.url();
  await frame.locator('#internal').click();
  await expect(panel.getByText('The link to /somewhere/else was not opened')).toBeVisible();
  expect(page.url()).toBe(before);
  await expect(frame.locator('#internal')).toBeVisible();
});
