/**
 * Which DuckDB extensions the app loads at boot during e2e tests.
 *
 * Every test boots a fresh engine, and loading all nine startup extensions is
 * ~3s of a ~5s boot. Tests get the base set below instead, through a
 * localStorage key the dev server honours (`testExtensionSelection` in
 * src/lib/duckdb-engine.ts); published builds ignore it. A spec that needs
 * more asks for them:
 *
 *   test.use({ storageState: withExtensions("autocomplete") });
 *
 * The required vgi extension always loads. Extensions cannot be left to
 * autoload instead (it hangs the engine), so a test that uses one it did not
 * ask for fails with a "not in the catalog" error naming the extension.
 *
 * CUPOLA_TEST_ALL_EXTENSIONS=1 loads every extension, as users get, to tell
 * whether a failure comes from the smaller set.
 *
 * No Playwright imports: playwright.config.ts uses this too.
 */

/** The key the app reads; must match TEST_EXTENSIONS_KEY in duckdb-engine.ts. */
const KEY = "cupola.test.extensions";

/** icu (time zones), json and httpfs are used throughout; vgi is required. */
export const BASE_TEST_EXTENSIONS = ["icu", "json", "httpfs", "vgi"] as const;

/** Same resolution as playwright.config.ts. */
const APP_ORIGIN = process.env.CUPOLA_APP_ORIGIN || "http://localhost:4321";

/** A Playwright storageState that boots the app with the base set plus `extra`. */
export function withExtensions(...extra: string[]) {
  if (process.env.CUPOLA_TEST_ALL_EXTENSIONS === "1") return { cookies: [], origins: [] };
  return {
    cookies: [],
    origins: [{
      origin: APP_ORIGIN,
      localStorage: [{ name: KEY, value: [...BASE_TEST_EXTENSIONS, ...extra].join(",") }],
    }],
  };
}
