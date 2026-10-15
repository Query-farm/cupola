import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { SHELL_EXTENSIONS } from "../src/lib/duckdb-engine";
import { gotoApp, shellQuery, waitForShellBridge } from "./helpers";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionVersion = `v${pkg.dependencies["@haybarn/haybarn-wasm"].split("-")[0]}`;

// Optional extension failures do not abort startup. Exercise the full startup
// list so an engine upgrade cannot silently remove capabilities from the app.
test.use({ storageState: { cookies: [], origins: [] } });

test("Haybarn and every startup extension load together", async ({ page }) => {
  const extensionRequests: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.hostname === "haybarn-extensions.query.farm") extensionRequests.push(url);
  });
  await gotoApp(page);
  await waitForShellBridge(page);
  await page.evaluate(() => (window as any).__bridge.attached);

  // The engine's SQL version can include commits beyond the upstream tag;
  // the published compatibility directory is what the extensions must match.
  expect(extensionRequests.length).toBeGreaterThan(0);
  for (const url of extensionRequests) {
    expect(url.pathname).toContain(`/${extensionVersion}/`);
  }

  const extensions = await shellQuery(page, "SELECT extension_name FROM duckdb_extensions() WHERE loaded");
  expect(extensions.ok, extensions.error).toBe(true);
  expect(extensions.rows?.map(row => row.extension_name)).toEqual(
    expect.arrayContaining(SHELL_EXTENSIONS.map(extension => extension.name)),
  );

  const functions = await shellQuery(page, `
    SELECT ST_AsText(ST_Point(1, 2)) AS point,
           json_extract_string('{"release":"ready"}', '$.release') AS json_value,
           timezone('UTC', TIMESTAMPTZ '2026-01-01 00:00:00+00')::VARCHAR AS utc,
           (SELECT (count(*) > 0)::INTEGER FROM sql_auto_complete('SEL')) AS autocomplete
  `);
  expect(functions.ok, functions.error).toBe(true);
  expect(functions.rows).toEqual([{
    point: "POINT (1 2)",
    json_value: "ready",
    utc: "2026-01-01 00:00:00",
    autocomplete: 1,
  }]);
});
