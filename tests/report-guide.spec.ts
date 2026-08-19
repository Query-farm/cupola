import { expect, test } from "@playwright/test";
import { APP_ORIGIN, BASE } from "./helpers";

test("report guide explains the visualization toolkit with a humidity example", async ({ page }) => {
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);

  await expect(page.getByRole("heading", { name: /One humidity reading/ })).toBeVisible();
  await expect(page.getByText("68%", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Small graphics, dense with meaning" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Why not a gauge?" })).toBeVisible();
  await expect(page.getByText("Recommended over a gauge")).toBeVisible();
  await expect(page.getByText("Leaflet maps for sensor locations and geographic patterns.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every report block, from query to export" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The complete block reference" })).toBeVisible();
  await expect(page.locator("[data-block-reference]")).toHaveCount(12);

  for (const type of [
    "markdown",
    "ai_narrative",
    "kpi",
    "sparkline",
    "small_multiples",
    "bullet",
    "range_dot",
    "slopegraph",
    "table",
    "chart",
    "map",
    "perspective",
  ]) {
    await expect(page.locator(`[data-block-reference="${type}"]`)).toBeVisible();
  }

  await expect(page.getByRole("heading", { name: "Datasets and typed parameters" })).toBeVisible();
  await expect(page.getByText("multi_select", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Groups explain belonging; appearance explains status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How a report is built compositionally" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What report blocks do not do" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Cupola reports" })).toHaveAttribute("href", BASE);
});
