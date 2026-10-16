import { test, expect } from "@playwright/test";
import { APP_URL, SERVICE_URL, EVIDENCE_SERVICE_URL, BASE, APP_ORIGIN, typeInEditor } from "./helpers";
import { report } from "./reporting/fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("a reloaded pivot destination returns to Explore without an empty pivot", async ({ page }) => {
  await page.goto(`${APP_URL}&view=perspective`);
  await expect(page.getByTestId("tab-catalog")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
  await expect(page).toHaveURL(/view=catalog/);
});

test("a phone query retains its results through navigation, Back, and rotation", async ({ page }) => {
  await page.goto(`${APP_URL}&view=editor`);
  await expect(page.getByTestId("mobile-query")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("mobile-query").click();
  await typeInEditor(page, "SELECT * FROM (VALUES ('New York', 68), ('Boston', 61)) AS weather(city, temperature_f)");
  await expect(page.getByTestId("editor-run")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("editor-run").click();
  const rows = page.getByRole("list", { name: "Result rows" });
  await expect(rows).toContainText("New York", { timeout: 20_000 });
  await expect(page.getByTestId("mobile-results")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-editor").first()).toBeHidden();
  await page.getByRole("radio", { name: "Grid layout", exact: true }).click();
  await expect(rows).toBeHidden();
  await page.getByRole("radio", { name: "Lines layout", exact: true }).click();
  await expect(rows).toContainText("Boston");
  await page.getByTestId("tab-askai").click();
  await expect(page.getByRole("heading", { name: "Start with a question." })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-current", "page");
  await expect(rows).toContainText("New York");
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.getByTestId("mobile-navigation")).toHaveCount(0);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  await page.getByTestId("tab-askai").click();
  await expect(page).toHaveURL(/view=askai/);
  await page.getByTestId("tab-editor").click();
  await expect(page).toHaveURL(/view=editor/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows).toContainText("Boston");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("More exposes the shell and usable settings at a small phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(APP_URL);
  await page.getByTestId("mobile-more").click({ timeout: 30_000 });
  const more = page.getByRole("dialog", { name: "Your workspace", exact: true });
  await expect(more).toBeVisible();
  await more.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await more.getByTestId("tab-shell").click();
  await expect(more).toBeHidden();
  await expect(page).toHaveURL(/view=shell/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("report filters use a sheet and update a real rendered report", async ({ page }) => {
  const fixture = { ...report("Mobile temperature report"), serviceUrl: SERVICE_URL,
    source: '# Temperature check\n\n```sql temperature\nSELECT $city AS city, 68 AS temperature_f\n```\n\n{% table data="temperature" /%}',
    parameters: [{ id: "city", key: "city", label: "City", type: "text", defaultValue: "New York", required: true }],
  };
  await page.addInitScript(value => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(value.serviceUrl)}:${value.id}`, JSON.stringify(value)); } catch {}
  }, fixture);
  await page.goto(`${APP_ORIGIN}${BASE}reports?service=${encodeURIComponent(SERVICE_URL)}&report_service=local&evidence_report=${fixture.id}&view=reports`);
  const reportDocument = page.getByTestId("evidence-document");
  await expect(reportDocument).toContainText("New York", { timeout: 45_000 });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Report filters", exact: true });
  await expect(filters).toBeVisible();
  await filters.getByRole("textbox", { name: "City", exact: true }).fill("Boston");
  await expect(reportDocument).toContainText("New York");
  await filters.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(filters).toBeHidden();
  await expect(reportDocument).toContainText("Boston", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("library navigation survives browser Back", async ({ page }) => {
  await page.goto(`${APP_URL}&view=catalog`);
  await page.getByTestId("mobile-tab-library").click({ timeout: 30_000 });
  await expect(page.getByTestId("tab-reports")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("tab-notebooks").click();
  await expect(page.getByTestId("notebook-library")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("tab-notebooks")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(page.getByTestId("notebook-library")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("tab-reports")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("evidence-panel")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("tab-catalog")).toHaveAttribute("aria-current", "page");
});

test("catalog columns fit a phone and keep sorting and query actions available", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(EVIDENCE_SERVICE_URL)}&view=catalog#/catalog/cupola_test/schema/demo/table/daily_orders`);
  const columns = page.getByRole("table", { name: "Table columns" });
  await expect(columns).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => columns.evaluate(element => element.scrollWidth <= element.parentElement!.clientWidth)).toBe(true);
  await columns.getByRole("button", { name: "Name", exact: true }).click();
  await expect(columns.locator('[data-column="name"]').nth(1)).toContainText("avg_transaction_value");
  await page.getByRole("button", { name: "Actions for daily_orders", exact: true }).click();
  const actions = page.getByRole("dialog", { name: "daily_orders actions", exact: true });
  await expect(actions.getByRole("button", { name: "Relationships", exact: true })).toBeVisible();
  await expect(actions.getByTestId("table-pivot")).toBeVisible();
  await actions.getByTestId("table-query-menu").click();
  await expect(page.getByTestId("table-open-shell")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toBeVisible();
  await actions.getByTestId("table-query-create").click();
  await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("list", { name: "Result rows" })).toContainText("order_id", { timeout: 45_000 });
  await page.getByTestId("tab-catalog").click();
  await page.getByRole("link", { name: "Back to demo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tables", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 844 });
  await expect(page.getByRole("button", { name: "Relationships", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true })).toContainText("cupola_test");
});

test("function arguments stay readable without overflowing the catalog page", async ({ page }) => {
  await page.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(EVIDENCE_SERVICE_URL)}&view=catalog#/catalog/cupola_test/schema/main/function/forecast_daily`);
  await expect(page.getByRole("heading", { name: "Arguments", exact: true })).toBeVisible({ timeout: 30_000 });
  const argumentsTable = page.locator(".mobile-metadata-table").first();
  await expect(argumentsTable).toContainText("latitude");
  await expect(argumentsTable).toContainText("longitude");
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 740 });
    await expect.poll(() => page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect.poll(() => argumentsTable.evaluate(element => element.scrollWidth <= element.parentElement!.clientWidth)).toBe(true);
  }
});

test("catalog examples wrap, expand, copy, and run the same SQL on a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => { (window as any).__copiedSql = text; } });
  });
  await page.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(EVIDENCE_SERVICE_URL)}&view=catalog#/catalog/cupola_test/schema/demo/table/daily_orders`);
  await page.getByRole("button", { name: "Query 1", exact: true }).click({ timeout: 30_000 });
  const reader = page.locator("main .code-reader").last();
  await expect(reader.getByRole("button", { name: "Wrap lines", exact: true })).toHaveAttribute("aria-pressed", "true");
  const sql = (await reader.locator("pre > code").textContent())!;
  await expect.poll(() => reader.locator("pre").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await reader.locator("pre").boundingBox())!.width).toBeGreaterThan(230);
  await reader.getByRole("button", { name: "Expand SQL", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "SQL", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Wrap lines", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Wrap lines", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator("pre > code")).toHaveText(sql);
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copiedSql)).toBe(sql);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(reader.getByRole("button", { name: "Expand SQL", exact: true })).toBeFocused();
  await reader.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("list", { name: "Result rows" })).toContainText("order_id", { timeout: 45_000 });
});

test("catalog browsing comes before optional documentation and connection details", async ({ page }) => {
  await page.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(EVIDENCE_SERVICE_URL)}&view=catalog#/catalog/cupola_test`);
  const schemas = page.getByRole("heading", { name: "Schemas", exact: true });
  await expect(schemas).toBeVisible({ timeout: 30_000 });
  expect((await schemas.boundingBox())!.y).toBeLessThan(400);
  await expect(page.getByRole("button", { name: "Documentation", exact: true })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Connection instructions", exact: true }).click();
  await page.getByRole("tab", { name: "Python", exact: true }).click();
  const code = page.locator(".catalog-connect pre");
  await expect(code).toContainText("import haybarn");
  await expect.poll(() => code.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Expand Python connection", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Python connection", exact: true });
  await expect(dialog).toContainText("SHOW ALL TABLES");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
});

test("relationships start with a readable list and retain filtering, diagram, and table navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${APP_ORIGIN}${BASE}?service=${encodeURIComponent(EVIDENCE_SERVICE_URL)}&view=catalog#/catalog/cupola_test/schema/geo/relationships`);
  const list = page.getByRole("list", { name: "Tables and relationships" });
  await expect(list.getByRole("button", { name: "Open geo.places" })).toBeVisible({ timeout: 30_000 });
  expect((await page.locator('[data-testid="catalog-relationships"] > header').boundingBox())!.height).toBeLessThan(90);
  await page.getByRole("button", { name: "Relationship filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Relationship filters", exact: true });
  await filters.getByRole("textbox", { name: "Find a table" }).fill("sales");
  await filters.getByRole("button", { name: "Done", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Show relationship diagram", exact: true }).click();
  await expect(page.getByRole("button", { name: "Fit relationship layout" })).toBeVisible();
  await page.getByRole("button", { name: "Show relationship list", exact: true }).click();
  await list.getByRole("button", { name: "Open geo.sales" }).click();
  await expect(page.getByRole("table", { name: "Table columns" })).toBeVisible();
  await expect.poll(() => page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
