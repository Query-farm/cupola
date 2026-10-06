import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { APP_ORIGIN, BASE, SERVICE_URL } from './helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

async function seed(page: Page) {
  await page.addInitScript((serviceUrl) => {
    if (sessionStorage.getItem('sidebar-actions-seeded')) return;
    sessionStorage.setItem('sidebar-actions-seeded', '1');
    for (const connection of [serviceUrl, 'https://other.example']) {
      for (const id of ['one', 'two']) {
        localStorage.setItem(
          `cupola.notebook.v1:${encodeURIComponent(connection)}:${id}`,
          JSON.stringify({
            version: 1,
            id,
            serviceUrl: connection,
            title: `Notebook ${id}`,
            createdAt: 1,
            updatedAt: 1,
            cells: [
              {
                id: `${id}-cell`,
                type: 'sql',
                title: 'Query',
                source: 'select 42 as answer',
                collapsed: false,
                charts: [],
              },
            ],
          }),
        );
        localStorage.setItem(
          `cupola.evidence.report.v2:${encodeURIComponent(connection)}:${id}`,
          JSON.stringify({
            version: 1,
            id,
            serviceUrl: connection,
            title: `Report ${id}`,
            createdAt: 1,
            updatedAt: 1,
            source: '# A saved report\n\nOriginal content.',
            setupSql: '',
            parameters: [],
            values: {},
          }),
        );
      }
    }
  }, SERVICE_URL);
  await page.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(SERVICE_URL)}`);
  await expect(page.getByRole('navigation', { name: 'Saved notebooks' })).toBeVisible({
    timeout: 30_000,
  });
}

async function contextMenu(page: Page, collection: 'notebooks' | 'reports', title: string) {
  await page
    .getByRole('navigation', { name: `Saved ${collection}` })
    .getByRole('link', { name: title, exact: true })
    .click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `${title} actions`, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

async function documentScope(page: Page, serviceUrl = SERVICE_URL) {
  return page.evaluate(
    ({ serviceUrl, currentServiceUrl }) => {
      const localWorkspace = new URL(window.location.href).searchParams.get('local_ws');
      if (localWorkspace && serviceUrl === currentServiceUrl) return localWorkspace;
      // A ?service= link also opens a workspace, while keeping the service URL in the address bar.
      const workspaces = JSON.parse(localStorage.getItem('cupola.workspaces.v1') ?? '{"workspaces":[]}')
        .workspaces as { id: string; catalogs: { url: string }[] }[];
      return workspaces.find((workspace) => workspace.catalogs.some((catalog) => catalog.url === serviceUrl))?.id ?? serviceUrl;
    },
    { serviceUrl, currentServiceUrl: SERVICE_URL },
  );
}

async function saved(
  page: Page,
  kind: 'notebook' | 'report',
  id: string,
  serviceUrl = SERVICE_URL,
) {
  const scope = await documentScope(page, serviceUrl);
  return page.evaluate(
    ({ kind, id, serviceUrl, scope }) => {
      const prefix = kind === 'notebook' ? 'cupola.notebook.v1:' : 'cupola.evidence.report.v2:';
      const raw =
        localStorage.getItem(`${prefix}${encodeURIComponent(scope)}:${id}`) ??
        localStorage.getItem(`${prefix}${encodeURIComponent(serviceUrl)}:${id}`);
      return raw ? JSON.parse(raw) : null;
    },
    { kind, id, serviceUrl, scope },
  );
}

test('right-click, keyboard and visible action menus preserve sidebar navigation', async ({
  page,
}) => {
  await seed(page);
  const sidebar = page.getByRole('navigation', { name: 'Saved notebooks' });
  const link = sidebar.getByRole('link', { name: 'Notebook one', exact: true });
  const startingUrl = page.url();
  await contextMenu(page, 'notebooks', 'Notebook one');
  expect(page.url()).toBe(startingUrl);
  await page.keyboard.press('Escape');
  await link.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Notebook one actions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
  await sidebar.getByRole('button', { name: 'Actions for Notebook one' }).click();
  await expect(page.getByRole('menuitem', { name: 'Export notebook' })).toBeVisible();
  await page.keyboard.press('Escape');
  await link.click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Notebook one');
  await expect(page).toHaveURL(/notebook=one/);
});

for (const kind of ['notebook', 'report'] as const) {
  test(`${kind} menu renames, copies, exports and confirms deletion without affecting another connection`, async ({
    page,
  }) => {
    await seed(page);
    const collection = kind === 'notebook' ? 'notebooks' : 'reports';
    const original = kind === 'notebook' ? 'Notebook one' : 'Report one';
    const renamed = `Renamed ${kind}`;
    const sidebar = page.getByRole('navigation', { name: `Saved ${collection}` });
    if (kind === 'report') await sidebar.getByRole('link', { name: 'Reports' }).click();
    await (await contextMenu(page, collection, original))
      .getByRole('menuitem', { name: 'Rename…' })
      .click();
    const dialog = page.getByRole('dialog', { name: `Rename ${kind}` });
    await dialog.getByRole('textbox', { name: 'New name' }).fill(renamed);
    await dialog.getByRole('button', { name: 'Save name' }).click();
    await expect(dialog).toBeHidden();
    await expect(sidebar.getByRole('link', { name: renamed, exact: true })).toBeVisible();
    expect((await saved(page, kind, 'one')).title).toBe(renamed);
    expect((await saved(page, kind, 'one', 'https://other.example')).title).toBe(original);
    if (kind === 'report')
      await expect(
        page
          .getByRole('region', { name: 'Saved reports list' })
          .getByText(renamed, { exact: true }),
      ).toBeVisible();
    await (await contextMenu(page, collection, renamed))
      .getByRole('menuitem', { name: 'Duplicate', exact: true })
      .click();
    await expect(
      sidebar.getByRole('link', { name: `${renamed} (copy)`, exact: true }),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await (
      await contextMenu(page, collection, renamed)
    )
      .getByRole('menuitem', {
        name: kind === 'notebook' ? 'Export notebook' : 'Export report file',
      })
      .click();
    const download = await downloadPromise;
    const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(kind === 'notebook' ? exported.title : exported.reports[0].title).toBe(renamed);
    if (kind === 'report')
      expect(exported.reports[0].history.revisions.length).toBeGreaterThanOrEqual(2);
    await (await contextMenu(page, collection, renamed))
      .getByRole('menuitem', { name: 'Delete…' })
      .click();
    const deletion = page.getByRole('dialog', { name: `Delete ${kind}?` });
    await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await saved(page, kind, 'one')).not.toBeNull();
    await (await contextMenu(page, collection, renamed))
      .getByRole('menuitem', { name: 'Delete…' })
      .click();
    await deletion.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(sidebar.getByRole('link', { name: renamed, exact: true })).toHaveCount(0);
    expect(await saved(page, kind, 'one')).toBeNull();
    await expect(sidebar.getByRole('link', { name: kind === 'notebook' ? 'Notebooks' : 'Reports', exact: true })).toBeFocused();
    expect(await saved(page, kind, 'one', 'https://other.example')).not.toBeNull();
  });
}

test('open notebook actions retain current edits and deletion cannot be undone by autosave', async ({
  page,
}) => {
  await seed(page);
  const sidebar = page.getByRole('navigation', { name: 'Saved notebooks' });
  await sidebar.getByRole('link', { name: 'Notebook one', exact: true }).click();
  const editor = page.getByTestId('notebook-cell').first().locator('.cm-content');
  await editor.fill('select 123 as latest_edit');
  await (await contextMenu(page, 'notebooks', 'Notebook one'))
    .getByRole('menuitem', { name: 'Rename…' })
    .click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'New name' }).fill('Active notebook');
  await page.getByRole('dialog').getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue(
    'Active notebook',
  );
  expect((await saved(page, 'notebook', 'one')).cells[0].source).toBe('select 123 as latest_edit');
  await editor.fill('select 456 as pending_edit');
  const downloadPromise = page.waitForEvent('download');
  await (await contextMenu(page, 'notebooks', 'Active notebook'))
    .getByRole('menuitem', { name: 'Export notebook' })
    .click();
  const download = await downloadPromise;
  expect(JSON.parse(await readFile((await download.path())!, 'utf8')).cells[0].source).toBe(
    'select 456 as pending_edit',
  );
  await (await contextMenu(page, 'notebooks', 'Active notebook'))
    .getByRole('menuitem', { name: 'Duplicate', exact: true })
    .click();
  const copy = await page.evaluate(
    (scope) => {
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(`cupola.notebook.v1:${encodeURIComponent(scope)}:`))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
        .find((doc) => doc.title === 'Active notebook (copy)');
    },
    await documentScope(page),
  );
  expect(copy.cells[0].source).toBe('select 456 as pending_edit');
  await editor.fill('select 789 as delete_pending_edit');
  await (await contextMenu(page, 'notebooks', 'Active notebook'))
    .getByRole('menuitem', { name: 'Delete…' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByTestId('notebook-library')).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Active notebook', exact: true })).toHaveCount(0);
  // Allow a pending autosave to fire before checking that the deleted definition stays absent.
  await page.waitForTimeout(700);
  expect(await saved(page, 'notebook', 'one')).toBeNull();
});

test('open report actions export pending edits and deletion leaves no saved or recovery record', async ({
  page,
}) => {
  await seed(page);
  const sidebar = page.getByRole('navigation', { name: 'Saved reports' });
  await sidebar.getByRole('link', { name: 'Report one', exact: true }).click();
  await page.getByRole('button', { name: 'Edit report', exact: true }).click();
  const stopRefresh = page.getByRole('button', { name: 'Stop refresh', exact: true });
  if (await stopRefresh.isVisible()) await stopRefresh.click();
  await expect(stopRefresh).toHaveCount(0);
  const title = page.getByRole('textbox', { name: 'Report title', exact: true });
  await title.fill('Pending report title');
  const downloadPromise = page.waitForEvent('download');
  await (await contextMenu(page, 'reports', 'Report one'))
    .getByRole('menuitem', { name: 'Export report file' })
    .click();
  const download = await downloadPromise;
  expect(JSON.parse(await readFile((await download.path())!, 'utf8')).reports[0].title).toBe(
    'Pending report title',
  );
  // The report name can autosave during the download; resolve the current saved sidebar label.
  const currentTitle = (await saved(page, 'report', 'one')).title;
  await (await contextMenu(page, 'reports', currentTitle))
    .getByRole('menuitem', { name: 'Rename…' })
    .click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'New name' }).fill('Active report');
  await page.getByRole('dialog').getByRole('button', { name: 'Save name' }).click();
  await expect(title).toHaveValue('Active report');
  await title.fill('Pending deletion');
  await (await contextMenu(page, 'reports', 'Active report'))
    .getByRole('menuitem', { name: 'Delete…' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByRole('region', { name: 'Saved reports list' })).toBeVisible();
  await page.waitForTimeout(1800);
  expect(await saved(page, 'report', 'one')).toBeNull();
  await expect(sidebar.getByRole('link', { name: /Active report|Pending deletion/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole('region', { name: 'Unsaved reports' })).toHaveCount(0);
  // Restoring the same ID through Import must reopen a working editor, rather than stay deleted.
  await page.getByLabel('Report files to import').setInputFiles({
    name: 'restored.cupola-reports.json',
    mimeType: 'application/json',
    buffer: Buffer.from(await readFile((await download.path())!, 'utf8')),
  });
  await sidebar.getByRole('link', { name: 'Pending report title', exact: true }).click();
  await page.getByRole('button', { name: 'Edit report', exact: true }).click();
  await title.fill('Restored report');
  await expect
    .poll(async () => (await saved(page, 'report', 'one'))?.title)
    .toBe('Restored report');
});
