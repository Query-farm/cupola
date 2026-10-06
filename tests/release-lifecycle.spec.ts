import { test, expect } from "@playwright/test";

test("old bookmarks reach stable URLs with query and fragment intact", async ({ page }) => {
  await page.goto("/v0.1.0/?name=kept#keep=fragment");
  await expect(page).toHaveURL(/\/\?name=kept#keep=fragment$/);
  await expect(page).toHaveTitle(/Cupola/);
});

test("update notice lets users keep working and only reloads explicitly", async ({ page }) => {
  await page.route("**/release.json", route => route.fulfill({ json: { version: "99.0.0", publishedAt: new Date().toISOString() } }));
  await page.goto("/");
  const notice = page.getByRole("complementary", { name: "Cupola update" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Reload to update" }).click();
  await expect(notice).toContainText("wait for running queries");
  await notice.getByRole("button", { name: "Keep working" }).click();
  await expect(notice.getByRole("button", { name: "Reload to update" })).toBeVisible();
  await notice.getByRole("button", { name: "Reload to update" }).click();
  await Promise.all([page.waitForEvent("load"), notice.getByRole("button", { name: "Reload now" }).click()]);
});

test("failed update checks do not interrupt the app", async ({ page }) => {
  await page.route("**/release.json", route => route.abort());
  await page.goto("/");
  await expect(page).toHaveTitle(/Cupola/);
  await expect(page.getByRole("complementary", { name: "Cupola update" })).toHaveCount(0);
});

test("stable app connects to the hosted VGI service", async ({ page }) => {
  await page.goto("/?service=https%3A%2F%2Fvgi-open-meteo.rusty-bb6.workers.dev&vgi_version=latest");
  await expect(page.getByRole("tree").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("treeitem").first()).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});
