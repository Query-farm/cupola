import { expect, test, type Page } from "@playwright/test";
import { APP_ORIGIN, BASE, T_SHELL_BOOT, waitForShellBridge } from "./helpers";
import type { ReportParameter } from "../src/lib/reports/types";
import type { SemanticCompileResult } from "../src/lib/semantic-compiler";
import {
  salesRef,
  customersRef,
  forecastRef,
  customerRelationship,
} from "./fixtures/report-semantic-catalogs";


const fixtureUrl = `${BASE}tests/fixtures/report-semantic-browser.tsx`;
async function setup(
  page: Page,
  query: Record<string, any> = {},
  functions: boolean | "pipeline" = false,
  parameters: ReportParameter[] = [],
) {
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await page.evaluate(
    async ({ url, query, functions, parameters }) =>
      (await import(/* @vite-ignore */ url)).mountBuilder(
        query,
        functions,
        parameters,
      ),
    { url: fixtureUrl, query, functions, parameters },
  );
  const view = page.locator("#semantic-test-host");
  await expect(view.getByTestId("report-semantic-builder")).toBeVisible();
  const change = async (label: string, value: string) => {
    const field = view.getByLabel(label, { exact: true });
    const details = field.locator("xpath=ancestor::details");
    for (const detail of await details.all())
      if ((await detail.getAttribute("open")) === null)
        await detail.locator(":scope > summary").click();
    if (await field.evaluate((element) => element.tagName === "SELECT"))
      await field.selectOption(value);
    else await field.fill(value);
  };
  const click = async (name: string) => {
    const button = view.getByRole("button", {
      name,
      exact: true,
      includeHidden: true,
    });
    for (const detail of await button.locator("xpath=ancestor::details").all())
      if ((await detail.getAttribute("open")) === null)
        await detail.locator(":scope > summary").click();
    await button.click();
  };
  const state = async () =>
    JSON.parse((await view.getByTestId("semantic-query-state").textContent())!);
  return {
    view,
    change,
    click,
    compile: async (): Promise<SemanticCompileResult> =>
      (await state()).compiled,
    query: async () => (await state()).query,
  };
}

test("visual selections, conformed branches and cross-fact formula compile; renames preserve dependencies", async ({
  page,
}) => {
  const { view, change, click, compile, query } = await setup(page);
  await expect(
    view.getByRole("button", { name: "Add formula", includeHidden: true }),
  ).toBeDisabled();
  await view.getByRole("checkbox", { name: /Net revenue/ }).click();
  await view.getByRole("checkbox", { name: /^Customers/ }).click();
  await change("Net revenue missing fact value", "null");
  await change("Customers missing fact value", "null");
  await view.getByRole("checkbox", { name: /customer id customers/ }).click();
  await change(
    "customer_id member for orders",
    JSON.stringify({ ...salesRef, member_id: "customer_id" }),
  );
  await click("Add formula");
  await change("Formula 1 name", "revenue_per_customer");
  await change("Formula 1 unit", "USD/customer");
  await change("Net revenue output name", "net_sales");
  expect((await query()).derived_measures[0].expression.left.member).toBe(
    "net_sales",
  );
  const result = await compile();
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
  if (!result.ok) return;
  expect(result.plan.stitch?.strategy).toBe("conformed_dimension_spine");
  expect(result.plan.output_units?.revenue_per_customer).toBe("USD/customer");
  expect(result.plan.sql).toContain('AS "revenue_per_customer"');
  await expect(view.getByTestId("semantic-query-validation")).toContainText(
    "Model validation passed",
  );
});

test("nested date-range filters retain grouping and resolve typed report controls", async ({
  page,
}) => {
  const parameters: ReportParameter[] = [
    {
      id: "period",
      key: "period",
      label: "Period",
      type: "date_range",
      defaultValue: { start: "2026-09-01", end: "2026-09-30" },
    },
  ];
  const { change, click, compile, query } = await setup(
    page,
    { measures: [{ ...salesRef, member_id: "revenue" }] },
    false,
    parameters,
  );
  await click("Add filter");
  await change(
    "Filter member",
    JSON.stringify({ ...salesRef, member_id: "ordered_at" }),
  );
  await change("Filter operator", "between");
  await change("Filter value 1 source", "parameter");
  await change("Filter value 2 source", "parameter");
  await change(
    "Filter value 2",
    JSON.stringify({ report_parameter: "period", part: "end" }),
  );
  await change("Filter match", "or");
  await click("Add condition");
  await change(
    "Filter 2 member",
    JSON.stringify({ ...salesRef, member_id: "customer_id" }),
  );
  await change("Filter 2 operator", "is_null");
  expect((await query()).filters.or[0].values).toEqual([
    { report_parameter: "period", part: "start" },
    { report_parameter: "period", part: "end" },
  ]);
  const result = await compile();
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
  if (result.ok) {
    expect(result.plan.parameters).toEqual(["2026-09-01", "2026-09-30"]);
    expect(result.plan.sql).toContain(" OR ");
    expect(result.plan.sql).toContain("BETWEEN ? AND ?");
  }
});

test("explicit relationship paths and post-aggregation filters survive unrelated edits", async ({
  page,
}) => {
  const filters = {
    or: [
      { member: "revenue", operator: "gt", value: 5 },
      { member: "revenue", operator: "is_null" },
    ],
  };
  const { change, compile, query } = await setup(page, {
    measures: [{ ...salesRef, member_id: "revenue" }],
    dimensions: [{ ...customersRef, member_id: "country" }],
    measure_filters: filters,
    order: [{ member: "revenue", direction: "desc" }],
  });
  await change(
    "Path to country next step",
    customerRelationship.relationship_id,
  );
  await change("Net revenue output name", "sales_total");
  expect((await query()).measure_filters.or[0]).toEqual({
    member: "sales_total",
    operator: "gt",
    value: 5,
  });
  expect((await query()).order[0].member).toBe("sales_total");
  expect((await query()).dimensions[0].relationship_path).toEqual([
    customerRelationship.relationship_id,
  ]);
  const result = await compile();
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
});

test("builds a parameterized input table and correlated function stage; renames retain bindings", async ({
  page,
}) => {
  const parameters: ReportParameter[] = [
    {
      id: "city",
      key: "city",
      label: "City",
      type: "text",
      defaultValue: "Richmond",
    },
  ];
  const { view, change, click, compile, query } = await setup(
    page,
    { measures: [{ ...forecastRef, member_id: "average_temperature" }] },
    true,
    parameters,
  );
  await click("Add input table");
  await change("Input 1 name", "cities");
  await change("Input 1 column 1 name", "city");
  await change("cities row 1 city source", "parameter");
  await click("Add function stage");
  await change(
    "Stage 1 argument city",
    JSON.stringify({ input_column: "city" }),
  );
  await change("Input 1 name", "locations");
  await change("Input 1 column 1 name", "place");
  expect((await query()).source_bindings[0].driver).toEqual({
    input_id: "locations",
  });
  expect((await query()).source_bindings[0].arguments.city).toEqual({
    input_column: "place",
  });
  await view.getByRole("checkbox", { name: /Allow reduction/ }).click();
  const result = await compile();
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
  if (!result.ok) return;
  expect(result.plan.parameters).toContain("Richmond");
  expect(result.plan.sql).toContain("LATERAL");
  expect(result.plan.output_units?.average_temperature).toBe("Cel");
});

test("numeric filters accept negative decimals and reject incomplete numeric drafts", async ({
  page,
}) => {
  const { view, change, click, compile, query } = await setup(page, {
    measures: [{ ...salesRef, member_id: "revenue" }],
  });
  await click("Add measure filter");
  await change("Measure filter value source", "number");
  const field = view.getByLabel("Measure filter value", { exact: true });
  await field.fill("");
  expect((await compile()).ok).toBe(false);
  await field.pressSequentially("-12.5");
  expect((await query()).measure_filters.value).toBe(-12.5);
  expect((await compile()).ok).toBe(true);
});

test("function pipelines compile chained entity drivers and retain filters and bounds", async ({
  page,
}) => {
  const { view, change, click, compile } = await setup(
    page,
    {
      measures: [
        {
          catalog_id: "com.example.outlook",
          entity_id: "outlook",
          member_id: "average_temperature",
        },
      ],
    },
    "pipeline",
  );
  await click("Add input table");
  await change("input_1 row 1 id", "Richmond");
  await click("Add function stage");
  await change("Stage 1 argument city", JSON.stringify({ input_column: "id" }));
  await change("Stage 1 maximum output rows", "2");
  await click("Add function stage");
  await change("Stage 2 driver", "entity:com.example.weather::forecast");
  await change("Stage 2 maximum driver rows", "2");
  await change(
    "Stage 2 argument city",
    JSON.stringify({ member: { ...forecastRef, member_id: "city" } }),
  );
  await click("Add stage 2 driver filter");
  await change(
    "Stage 2 driver filter member",
    JSON.stringify({ ...forecastRef, member_id: "city" }),
  );
  await change("Stage 2 driver filter value", "Richmond");
  await view.getByRole("checkbox", { name: /Allow reduction/ }).click();
  const result = await compile();
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
  if (result.ok) {
    expect(result.plan.fact_branches[0].invocations).toHaveLength(2);
    expect(result.plan.sql).toContain("LATERAL");
  }
});

test("new report → KPI → governed dataset → live test → apply preserves model labels and units", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await waitForShellBridge(page);
  await page.evaluate(
    async (url) => (await import(/* @vite-ignore */ url)).mountWorkspace(),
    fixtureUrl,
  );
  const workspace = page.locator("#semantic-test-host");
  await workspace.getByTestId("report-add-block").click();
  // Menus are rendered in a portal outside the workspace.
  await page.getByTestId("report-add-kpi").click();
  const editor = workspace.getByTestId("report-block-editor");
  await expect(
    editor.getByText("This report has no datasets for blocks yet."),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Add governed metrics" }).click();
  await expect(
    workspace.getByTestId("semantic-query-validation"),
  ).toContainText("Model validation passed");
  await workspace.getByText("Advanced semantic JSON", { exact: true }).click();
  const jsonEditor = workspace.getByTestId("report-dataset-semantic-editor");
  // Catalog order comes from the session inventory. Select the intended
  // measure explicitly instead of depending on which catalog sorts first.
  await jsonEditor.fill(JSON.stringify({ measures: [{ ...salesRef, member_id: 'revenue' }], limit: 1000 }));
  const validQuery = await jsonEditor.inputValue();
  await jsonEditor.fill('{"measures":[null]}');
  await expect(
    workspace.getByText(/Repair it in Advanced semantic JSON/),
  ).toBeVisible();
  await jsonEditor.fill(validQuery);
  await expect(
    workspace.getByTestId("semantic-query-validation"),
  ).toContainText("Model validation passed");
  await workspace
    .getByRole("button", { name: "Test query", exact: true })
    .click();
  await expect(workspace.getByTestId("report-apply-dataset")).toBeEnabled({
    timeout: T_SHELL_BOOT,
  });
  await workspace.getByTestId("report-apply-dataset").click();
  await expect(editor).toBeVisible();
  await editor.getByLabel("Value", { exact: true }).selectOption("revenue");
  await expect(
    editor
      .getByLabel("Value", { exact: true })
      .locator('option[value="revenue"]'),
  ).toHaveText("Net revenue (USD) · revenue");
  await expect(editor.getByLabel("Title", { exact: true })).toHaveAttribute(
    "placeholder",
    "Net revenue",
  );
  await expect(
    editor.getByText("Revenue after discounts.", { exact: false }),
  ).toBeVisible();
  await editor.getByTestId("report-block-apply").click();
  await expect(workspace.getByTestId("report-kpi-value")).toHaveText("120 USD");
  await workspace.getByRole("button", { name: "Save report draft" }).click();
  await expect(
    workspace.getByRole("button", { name: "Save report draft" }),
  ).toBeDisabled();
  const saved = await page.evaluate(
    async (url) => (await import(/* @vite-ignore */ url)).getSavedReport(),
    fixtureUrl,
  );
  expect(saved.document.datasets[0].kind).toBe("semantic");
  expect(saved.document.blocks[0].valueColumn).toBe("revenue");
  expect(saved.document.blocks[0].title).toBeUndefined();
  expect(errors).toEqual([]);
});

test('semantic field tree keeps selections, supplies names and disambiguates duplicate outputs', async ({ page }) => {
  const { view, query } = await setup(page);
  const revenue = view.getByRole('checkbox', { name: /Net revenue/ });
  await revenue.check();
  const output = view.getByLabel('Net revenue output name', { exact: true });
  await expect(output).toHaveValue('revenue');
  await output.fill('net_sales');
  await view.getByRole('checkbox', { name: /customer id orders/ }).check();
  await view.getByRole('checkbox', { name: /customer id customers/ }).check();
  expect((await query()).dimensions.map((item: any) => item.alias || item.member_id)).toEqual(['customer_id', 'customers_customer_id']);
  const catalog = view.getByRole('button', { name: 'Catalog com.example.sales', exact: true });
  await catalog.click();
  await expect(catalog).toHaveAttribute('aria-expanded', 'false');
  await expect(output).toHaveCount(0);
  const search = view.getByRole('textbox', { name: 'Find semantic fields' });
  await search.fill('revenue after discounts');
  await expect(catalog).toHaveAttribute('aria-expanded', 'true');
  await expect(output).toHaveValue('net_sales');
  await expect(revenue).toBeChecked();
  await search.fill('no_such_field');
  await expect(view).toContainText('No matching fields');
  await search.fill('');
  await expect(catalog).toHaveAttribute('aria-expanded', 'false');
  await view.getByRole('button', { name: 'Selected only', exact: true }).click();
  await expect(output).toHaveValue('net_sales');
  await expect(view.getByRole('checkbox')).toHaveCount(3);
  await expect(view).toContainText('1 measures · 2 dimensions selected');
});
