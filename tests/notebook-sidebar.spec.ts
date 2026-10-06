import { test, expect, type Page } from '@playwright/test';
import { APP_ORIGIN, BASE, SERVICE_URL, waitForShellBridge } from './helpers';

async function seed(page: Page) {
  await page.addInitScript((serviceUrl) => {
    if (sessionStorage.getItem('notebooks-seeded')) return;
    sessionStorage.setItem('notebooks-seeded', '1');
    for (const [id, title, connection] of [
      ['first', 'First notebook', serviceUrl],
      ['second', 'Second notebook', serviceUrl],
      ['other', 'Other connection notebook', 'https://other.example'],
    ]) {
      localStorage.setItem(
        `cupola.notebook.v1:${encodeURIComponent(connection)}:${id}`,
        JSON.stringify({
          version: 1,
          id,
          title,
          serviceUrl: connection,
          createdAt: 1,
          updatedAt: 1,
          cells: [
            {
              id: `${id}-sql`,
              type: 'sql',
              title: 'Query',
              source: 'select 42 as answer',
              collapsed: false,
              charts: [],
            },
          ],
        }),
      );
    }
  }, SERVICE_URL);
  await page.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(SERVICE_URL)}`);
  if ((page.viewportSize()?.width ?? 1000) < 768)
    await page.getByRole('button', { name: 'Show catalog sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Saved notebooks' })).toBeVisible({ timeout: 30_000 });
}

/** Write a notebook as another tab would, under the key the app now reads: the
 *  workspace the `?service=` link opened (notebooks are kept per workspace).
 *  The seeded copy under the service URL is only a read-only fallback. */
async function editInOtherTab(page: Page, id: string, title: string) {
  await page.evaluate(
    ({ serviceUrl, id, title }) => {
      const workspaces = JSON.parse(localStorage.getItem('cupola.workspaces.v1')!).workspaces as {
        id: string;
        catalogs: { url: string }[];
      }[];
      const workspace = workspaces.find((w) => w.catalogs.some((c) => c.url === serviceUrl))!;
      const key = `cupola.notebook.v1:${encodeURIComponent(workspace.id)}:${id}`;
      const legacy = `cupola.notebook.v1:${encodeURIComponent(serviceUrl)}:${id}`;
      const doc = JSON.parse(localStorage.getItem(key) ?? localStorage.getItem(legacy)!);
      localStorage.setItem(key, JSON.stringify({ ...doc, workspaceId: workspace.id, title }));
    },
    { serviceUrl: SERVICE_URL, id, title },
  );
}

test('sidebar notebooks navigate in place, update names, filter, and restore direct links', async ({
  page,
}) => {
  await seed(page);
  const sidebar = page.getByRole('navigation', { name: 'Saved notebooks' });
  await expect(sidebar.getByRole('link', { name: 'Other connection notebook' })).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__notebookDocument = true;
  });
  await sidebar.getByRole('link', { name: 'First notebook', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Notebook title', exact: true });
  await expect(title).toHaveValue('First notebook');
  await expect(page).toHaveURL(/notebook=first/);
  await page.goBack();
  await expect(page.getByTestId('tab-catalog')).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(title).toHaveValue('First notebook');
  await expect(sidebar.getByRole('link', { name: 'First notebook', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await title.fill('Renamed notebook');
  await expect(sidebar.getByRole('link', { name: 'Renamed notebook', exact: true })).toBeVisible();
  await sidebar.getByRole('link', { name: 'Second notebook', exact: true }).click();
  await expect(title).toHaveValue('Second notebook');
  await page.goBack();
  await expect(title).toHaveValue('Renamed notebook');
  await page.goForward();
  await expect(title).toHaveValue('Second notebook');
  expect(await page.evaluate(() => (window as any).__notebookDocument)).toBe(true);
  await page.getByTestId('tab-editor').click();
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(0);
  await sidebar.getByRole('link', { name: 'Renamed notebook', exact: true }).click();
  await expect(title).toHaveValue('Renamed notebook');
  await page.reload();
  await expect(title).toHaveValue('Renamed notebook');
  await expect(sidebar.getByRole('link', { name: 'Renamed notebook', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const filter = page.getByRole('textbox', { name: 'Filter catalog', exact: true });
  await filter.fill('renamed');
  await expect(sidebar.getByRole('link', { name: 'Second notebook' })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Renamed notebook' })).toBeVisible();
  await filter.fill('');
  await sidebar.getByRole('link', { name: 'All notebooks', exact: true }).click();
  await expect(page.getByTestId('notebook-library')).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'All notebooks' })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(title).toHaveValue('Renamed notebook');
  const popupPromise = page.context().waitForEvent('page');
  await sidebar
    .getByRole('link', { name: 'Second notebook' })
    .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  const popup = await popupPromise;
  await expect(popup.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Second notebook', {
    timeout: 30_000,
  });
  await popup.close();
  await expect(title).toHaveValue('Renamed notebook');
});

test('notebook links restore the URL when the requested workspace is already mounted', async ({ page }) => {
  await seed(page);
  const sidebar = page.getByRole('navigation', { name: 'Saved notebooks' });
  const library = page.getByTestId('notebook-library');
  await sidebar.getByRole('link', { name: 'All notebooks', exact: true }).click();
  await expect(library).toBeVisible();
  await expect(page).toHaveURL(/\/notebooks\?service=/);
  await page.reload();
  await expect(library).toBeVisible();

  await sidebar.getByRole('link', { name: 'First notebook', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Notebook title', exact: true });
  await expect(title).toHaveValue('First notebook');
  await title.fill('Edits kept while switching surfaces');
  await page.getByRole('navigation', { name: 'Saved reports' })
    .getByRole('link', { name: 'All reports', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/saved\?/);
  await sidebar.getByRole('link', { name: 'Edits kept while switching surfaces', exact: true }).click();
  await expect(title).toHaveValue('Edits kept while switching surfaces');
  await expect(page).toHaveURL(/\/notebooks\?.*notebook=first/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();

  await page.goBack();
  await expect(page.getByTestId('tab-reports')).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(title).toHaveValue('Edits kept while switching surfaces');
  await page.reload();
  await expect(title).toHaveValue('Edits kept while switching surfaces');
});

test('sidebar creates notebooks, reflects deletion and cross-tab changes, and remembers collapse', async ({
  page,
}) => {
  await seed(page);
  const root = page.getByTestId('catalog-sidebar');
  const sidebar = page.getByRole('navigation', { name: 'Saved notebooks' });
  await root.getByRole('button', { name: 'New notebook', exact: true }).click();
  await page.getByRole('textbox', { name: 'Notebook title' }).fill('Created from sidebar');
  await expect(sidebar.getByRole('link', { name: 'Created from sidebar' })).toBeVisible();
  await sidebar.getByRole('link', { name: 'All notebooks' }).click();
  const library = page.getByTestId('notebook-library');
  await library.getByRole('textbox', { name: 'Search notebooks' }).fill('Created from sidebar');
  await library.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm delete' }).click();
  await expect(sidebar.getByRole('link', { name: 'Created from sidebar' })).toHaveCount(0);
  const other = await page.context().newPage();
  await other.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(SERVICE_URL)}`);
  await editInOtherTab(other, 'first', 'Changed in another tab');
  await expect(sidebar.getByRole('link', { name: 'Changed in another tab' })).toBeVisible();
  await other.close();
  await page.getByTestId('sidebar-notebooks-toggle').click();
  await expect(sidebar).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('sidebar-notebooks-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('textbox', { name: 'Filter catalog' }).fill('Changed in another');
  await expect(sidebar.getByRole('link', { name: 'Changed in another tab' })).toBeVisible();
});

test('sidebar navigation preserves the active notebook while running or unable to save', async ({ page }) => {
  await seed(page);
  await waitForShellBridge(page, 30_000);
  const sidebar = page.getByRole('navigation', { name: 'Saved notebooks' });
  await sidebar.getByRole('link', { name: 'First notebook' }).click();
  const cell = page.getByTestId('notebook-cell').first();
  await cell.locator('.cm-content').fill('SELECT count(*) FROM cupola_test.edge.slow_rows(100000, 2000)');
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await sidebar.getByRole('link', { name: 'Second notebook' }).click();
  await expect(page.getByText(/Notebook was kept open/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('First notebook');
  await expect(page).toHaveURL(/notebook=first/);
  await cell.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(cell.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 15_000 });
  await sidebar.getByRole('link', { name: 'Second notebook' }).click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Second notebook');
  await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible();
  await editInOtherTab(page, 'second', 'Other tab wins');
  await sidebar.getByRole('link', { name: 'First notebook' }).click();
  await expect(page.getByText(/Notebook was kept open/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Second notebook');
  await expect(page.getByTestId('notebook-workspace').getByRole('alert')).toContainText('another tab');
});

test('mobile sidebar closes when opening a notebook', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page
    .getByRole('navigation', { name: 'Saved notebooks' })
    .getByRole('link', { name: 'First notebook' })
    .click();
  await expect(page.getByTestId('catalog-sidebar')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('First notebook');
});

test('missing notebook links show a recoverable message and preserve saved documents', async ({ page }) => {
  await seed(page);
  await page.goto(
    `${APP_ORIGIN}${BASE}notebooks?service=${encodeURIComponent(SERVICE_URL)}&notebook=missing`,
  );
  await expect(page.getByTestId('notebook-library').getByRole('alert')).toContainText(
    'unavailable in this browser',
  );
  await page
    .getByRole('navigation', { name: 'Saved notebooks' })
    .getByRole('link', { name: 'First notebook' })
    .click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('First notebook');
});
