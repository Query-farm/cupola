import { expect, test } from "@playwright/test";
import { APP_ORIGIN, BASE, T_SHELL_BOOT } from "./helpers";

test("report guide is a runnable in-product gallery backed by canned local data", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);

  await expect(page.getByTestId("tab-reports")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Local report examples", { exact: true })).toBeVisible();
  await expect(page.locator(".report-authoring-control input").first()).toHaveValue("Cupola report block gallery", { timeout: T_SHELL_BOOT });
  await expect(page.getByText(/canned data queried locally/i)).toBeVisible();
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Glen Allen, Virginia");

  for (const id of [
    "showcase-markdown",
    "showcase-kpi",
    "showcase-sparkline",
    "showcase-ai",
    "showcase-small-multiples",
    "showcase-bullet",
    "showcase-range-dot",
    "showcase-slopegraph",
    "showcase-chart",
    "showcase-map",
    "showcase-table",
    "showcase-perspective",
  ]) {
    await expect(page.getByTestId(`report-block-${id}`)).toBeAttached();
  }

  await expect(page.getByTestId("report-block-showcase-kpi")).toContainText("68", { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-block-showcase-table")).toContainText("2026-08-20 07:00:00", { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("reports-run")).toHaveText(/Run report/, { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-block-showcase-chart").locator("svg")).toBeAttached();
  await expect(page.getByTestId("report-block-showcase-small-multiples").locator("svg")).toBeAttached();
  await expect(page.getByTestId("report-block-showcase-sparkline").getByTestId("report-sparkline-split")).toHaveAttribute("aria-label", "Now · forecast begins");
  await expect(page.getByTestId("report-block-showcase-map").locator(".leaflet-container")).toBeAttached();
  await expect(page.getByTestId("report-block-showcase-perspective").locator("perspective-viewer")).toBeAttached({ timeout: T_SHELL_BOOT });
  await expect(page.getByText("This page is a real report")).toBeAttached();
  await expect(page.getByText("AI-generated", { exact: false })).toBeAttached();
  await expect(page.getByText(/Run report to load data/i)).toHaveCount(0);

  await expect(page.getByTestId("report-block-showcase-kpi")).toHaveAttribute("data-report-tone", "warning");
  await page.getByTestId("report-parameters-toggle").click();
  await page.locator('input[type="number"]').fill("70");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("report-block-showcase-kpi")).toHaveAttribute("data-report-tone", "success", { timeout: T_SHELL_BOOT });

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByTestId("reports-workspace")).toHaveAttribute("data-report-mode", "reader");
  await expect(page.getByRole("heading", { name: "Cupola report block gallery" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agent" })).toHaveCount(0);
  await expect(page.locator(".react-resizable-handle").first()).toBeHidden();
  await expect(page.getByTestId("report-block-header-showcase-kpi")).toHaveCSS("cursor", "default");
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Glen Allen, Virginia");

  await page.getByRole("button", { name: "Edit report" }).click();
  await page.locator('input[value="Cupola report block gallery"]').fill("Unpublished gallery draft");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "View published" }).click();
  await expect(page.getByRole("heading", { name: "Cupola report block gallery" })).toBeVisible();
  await expect(page.getByText("Unpublished gallery draft")).toHaveCount(0);
});
