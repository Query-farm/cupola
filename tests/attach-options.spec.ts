import { test, expect, type Page } from "@playwright/test";
import { APP_ORIGIN, BASE, SERVICE_URL, T_NORMAL, T_SHELL_BOOT, openEditor, shellQuery, typeInEditor, waitForShellBridge } from "./helpers";

// Structured attach options (src/lib/attach/). Needs the test worker's
// attach-options variant beside the plain one:
//
//   PORT=9009 ./test-worker/run.sh
//   CUPOLA_TEST_ATTACH_OPTIONS=1 PORT=9010 ./test-worker/run.sh
//
// cupola_secure declares api_key (required, secret), region and max_rows
// (INTEGER), and refuses an ATTACH without api_key.
const OPTIONS_URL = process.env.VGI_OPTIONS_SERVICE_URL || "http://localhost:9010";
const RECENTS = "vgi-recent-services";
// Options are kept in the workspace store since multi-catalog phase 2; the
// recent list is read-only, migrated once.
const WORKSPACES = "cupola.workspaces.v1";
const SECRETS = "cupola.catalog-secrets.v1";

const appUrl = (service: string, attachOptions?: string) =>
  `${APP_ORIGIN}${BASE}?service=${encodeURIComponent(service)}` +
  (attachOptions === undefined ? "" : `&attach_options=${encodeURIComponent(attachOptions)}`);

async function optionsWorkerUp(): Promise<boolean> {
  try {
    // Node resolves localhost to ::1 first; the worker binds 127.0.0.1.
    return (await fetch(OPTIONS_URL.replace("//localhost", "//127.0.0.1"), { method: "GET" })).ok;
  } catch {
    return false;
  }
}

/** Start each test from empty storage, on the app's origin. */
async function freshStorage(page: Page) {
  await page.goto(`${APP_ORIGIN}${BASE}`);
  await page.evaluate(() => localStorage.clear());
}

async function storage(page: Page) {
  return page.evaluate(([r, w, s]) => ({ recents: localStorage.getItem(r) ?? "", workspaces: localStorage.getItem(w) ?? "", secrets: localStorage.getItem(s) ?? "" }), [RECENTS, WORKSPACES, SECRETS]);
}

async function regionCount(page: Page) {
  await waitForShellBridge(page);
  await expect.poll(async () => (await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM cupola_secure.small.regions")).rows?.[0]?.n,
    { timeout: T_SHELL_BOOT }).toBe(8);
}

test.describe("attach options", () => {
  test("a required secret entered in the form attaches, and stays out of recents, snippets and share links", async ({ page }) => {
    test.skip(!(await optionsWorkerUp()), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(90_000);
    // Capture the share link instead of writing the real clipboard.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t: string) => { (window as any).__copied = t; } },
      });
    });
    await freshStorage(page);
    const secret = "sk-e2e-secret-value-42";

    await page.goto(appUrl(OPTIONS_URL));
    const form = page.getByTestId("attach-options-required");
    await expect(form).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(form.locator("#attach-opt-api_key")).toHaveAttribute("type", "password");
    // Submitting without the required option is refused before any ATTACH.
    await form.getByRole("button", { name: "Connect" }).click();
    expect(await form.locator("#attach-opt-api_key").evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await expect(form).toBeVisible();

    await form.locator("#attach-opt-api_key").fill(secret);
    await form.locator("#attach-opt-max_rows").fill("12");
    await form.getByRole("button", { name: "Connect" }).click();

    await regionCount(page);
    const stored = await storage(page);
    expect(stored.workspaces).toContain('"max_rows":"12"');
    expect(stored.workspaces).not.toContain(secret);
    expect(stored.recents).not.toContain(secret);
    expect(stored.secrets).toContain(secret);

    // The catalog overview's snippet reads the secret from the environment.
    const snippet = page.locator("pre code").filter({ hasText: "ATTACH" }).first();
    await expect(snippet).toContainText("getenv('CUPOLA_SECURE_API_KEY')", { timeout: T_NORMAL });
    await expect(snippet).not.toContainText(secret);

    await openEditor(page);
    await typeInEditor(page, "SELECT 42");
    await page.getByTestId("editor-share-menu").click();
    await page.getByTestId("editor-share-link").click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied ?? "")).toContain("attach_options");
    const link = await page.evaluate(() => (window as any).__copied as string);
    expect(new URL(link).searchParams.get("attach_options")).toBe("max_rows '12'");
    expect(link).not.toContain(secret);
    expect(link).not.toContain("api_key");
  });

  test("an injection attempt through ?attach_options= is refused, not run", async ({ page }) => {
    test.setTimeout(90_000);
    await freshStorage(page);
    await page.goto(appUrl(SERVICE_URL, "opt 1); CREATE TABLE memory.main.pwned AS SELECT 1; --"));
    // The notice is modal, so the tree behind it is hidden from the a11y tree.
    const notice = page.getByTestId("attach-options-notice");
    await expect(notice).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(notice).toContainText("unbalanced brackets");
    // The raw text has left the address bar and storage.
    expect(page.url()).not.toContain("attach_options");
    expect((await storage(page)).recents).not.toContain("pwned");
    expect((await storage(page)).workspaces).not.toContain("pwned");
    await waitForShellBridge(page);
    await expect.poll(async () => (await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM duckdb_databases() WHERE database_name = 'cupola_test'")).rows?.[0]?.n,
      { timeout: T_SHELL_BOOT }).toBe(1);
    const pwned = await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 'pwned'");
    expect(pwned.rows?.[0]?.n).toBe(0);
  });

  test("a legacy raw options link is migrated: consent, evaluation, refusal, secret store", async ({ page }) => {
    test.skip(!(await optionsWorkerUp()), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(90_000);
    await freshStorage(page);
    const secret = "legacy-key-from-link";
    await page.goto(appUrl(OPTIONS_URL, `api_key '${secret}', max_rows CAST(7 AS INTEGER), region upper('x')`));

    const consent = page.getByTestId("attach-options-consent");
    await expect(consent).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(consent).toContainText("max_rows CAST(7 AS INTEGER)");
    await expect(consent).toContainText("region upper('x')");
    // A plain literal needs no consent.
    await expect(consent).not.toContainText(secret);
    await consent.getByRole("button", { name: "Use these options" }).click();

    await regionCount(page);
    const notice = page.getByTestId("attach-options-notice");
    await expect(notice).toContainText("region upper('x')");
    await expect(notice).toContainText("Only constants are accepted");
    expect(page.url()).not.toContain("attach_options");
    await expect.poll(async () => (await storage(page)).workspaces).toContain('"max_rows":"7"');
    const stored = await storage(page);
    expect(stored.workspaces).not.toContain(secret);
    expect(stored.workspaces).not.toContain("rawOptions");
    expect(stored.secrets).toContain(secret);
  });

  test("a stored pre-structured recent is migrated on read", async ({ page }) => {
    test.skip(!(await optionsWorkerUp()), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(90_000);
    await freshStorage(page);
    const secret = "stored-legacy-key-9";
    await page.evaluate(([key, url, s]) => localStorage.setItem(key, JSON.stringify([
      { url, catalogName: "cupola_secure", lastUsed: new Date().toISOString(), attachOptions: `api_key '${s}', max_rows 5` },
    ])), [RECENTS, OPTIONS_URL, secret]);
    await page.goto(appUrl(OPTIONS_URL));
    await regionCount(page);
    const stored = await storage(page);
    expect(stored.recents).not.toContain("attachOptions");
    expect(stored.recents).not.toContain(secret);
    expect(stored.recents).toContain('"max_rows":"5"');
    // The boot migration made it a workspace, its secret keyed by workspace and catalog.
    expect(stored.workspaces).toContain('"max_rows":"5"');
    expect(stored.workspaces).not.toContain(secret);
    expect(stored.secrets).toContain(secret);
  });

  test("a mistyped option is reported before ATTACH, with the redacted statement and a CLI script", async ({ page }) => {
    test.skip(!(await optionsWorkerUp()), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(90_000);
    await freshStorage(page);
    await page.goto(appUrl(OPTIONS_URL, "api_key 'typed-secret-77', max_rows 'abc'"));
    const panel = page.getByTestId("attach-error-panel");
    await expect(panel).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(panel).toContainText("max_rows: Not a valid INTEGER.");
    await expect(page.getByTestId("attach-error-sql")).toContainText("api_key '***'");
    await expect(panel).not.toContainText("typed-secret-77");
    await expect(panel.getByRole("button", { name: "Copy as duckdb CLI" })).toBeVisible();
  });

  test("a failed ATTACH shows the server's status and VGI headers", async ({ page }) => {
    test.skip(!(await optionsWorkerUp()), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(90_000);
    await freshStorage(page);
    await page.goto(appUrl(OPTIONS_URL, "api_key 'k-attach-fail', bogus 1"));
    const panel = page.getByTestId("attach-error-panel");
    await expect(panel).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(panel).toContainText("Unknown ATTACH option 'bogus'");
    await expect(panel).toContainText("HTTP status: 200");
    await expect(panel).toContainText(/vgi-supported-encodings/i);
    await expect(panel).not.toContainText("k-attach-fail");
  });
});
