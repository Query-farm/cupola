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
  await expect(page.getByRole("link", { name: "Open Cupola reports" })).toHaveAttribute("href", BASE);
});
