import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { SHELL_EXTENSIONS } from "../src/lib/duckdb-engine";
import { APP_URL, gotoApp, shellQuery, waitForShellBridge } from "./helpers";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionVersion = `v${pkg.dependencies["@haybarn/haybarn-wasm"].split("-")[0]}`;

// Optional extension failures do not abort startup. Exercise the full startup
// list so an engine upgrade cannot silently remove capabilities from the app.
test.use({ storageState: { cookies: [], origins: [] } });

for (const variant of ["coi", "eh"] as const) {
  test(`Haybarn ${variant.toUpperCase()} and every startup extension load together`, async ({ page }) => {
    if (variant === "eh") {
      // Remove isolation for real: SharedArrayBuffer is unavailable, so the app
      // must boot the single-threaded engine and use message-based cancellation.
      await page.route(APP_URL, async route => {
        const response = await route.fetch();
        const headers = response.headers();
        delete headers["cross-origin-embedder-policy"];
        await route.fulfill({ response, headers });
      });
    }
    const engineRequests: string[] = [];
    const extensionRequests: URL[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.hostname === "haybarn-extensions.query.farm") extensionRequests.push(url);
      if (url.pathname.includes("/haybarn/")) engineRequests.push(url.pathname);
    });
    await gotoApp(page);
    await waitForShellBridge(page);
    await page.evaluate(() => (window as any).__bridge.attached);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(variant === "coi");
    expect(engineRequests.filter(path => path.endsWith(".wasm"))).toEqual([
      expect.stringContaining(`/haybarn/duckdb-${variant}.wasm`),
    ]);

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
}

test("unsupported browsers get an actionable error before downloading the engine", async ({ page }) => {
  await page.addInitScript(() => {
    WebAssembly.validate = () => false;
  });
  const engineRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.includes("/haybarn/")) engineRequests.push(request.url());
  });
  await page.goto(APP_URL);
  const status = page.getByTestId("engine-status-ribbon");
  await expect(status).toHaveAttribute("data-engine-status", "error", { timeout: 20_000 });
  await expect(status).toContainText("Update your browser and try again.");
  expect(engineRequests).toEqual([]);
});
