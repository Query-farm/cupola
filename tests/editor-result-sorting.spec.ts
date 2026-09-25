import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
});

for (const { type, values } of [
  {
    type: "DATE",
    // Include epoch zero, dates outside JS Date's range, infinities, ties and nulls.
    values: ["2026-09-25", null, "infinity", "1970-01-01", "1969-12-31", "-infinity", "2026-09-25", "1000000-01-01"],
  },
  {
    type: "TIMESTAMP",
    // Sorting must retain sub-millisecond precision.
    values: ["2026-09-25 00:00:00.000002", null, "infinity", "1970-01-01", "1969-12-31", "-infinity", "2026-09-25 00:00:00.000002", "2026-09-25 00:00:00.000003"],
  },
]) {
  test(`${type} header cycles through chronological order and original order`, async ({ page }) => {
    const rows = values.map((value, i) => `(${i + 1}, ${value === null ? `NULL::${type}` : `${type} '${value}'`})`);
    await typeInEditor(page, `SELECT * FROM (VALUES ${rows.join(", ")}) t(id, occurred_at)`);
    await page.getByTestId("editor-run").click();

    const grid = page.getByRole("grid");
    const ids = grid.locator('tbody td[data-col="0"]');
    const header = grid.getByRole("button", { name: "occurred_at", exact: true });
    const original = ["1", "2", "3", "4", "5", "6", "7", "8"];
    await expect(ids).toHaveText(original, { timeout: T_NORMAL });

    await header.click();
    await expect(ids).toHaveText(["6", "5", "4", "1", "7", "8", "3", "2"]);
    await header.click();
    await expect(ids).toHaveText(["3", "8", "1", "7", "4", "5", "6", "2"]);
    await header.click();
    await expect(ids).toHaveText(original);
  });
}
