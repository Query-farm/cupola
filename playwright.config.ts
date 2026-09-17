import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);
const BASE_PATH = `/v${pkg.version}/`;
const APP_ORIGIN = process.env.CUPOLA_APP_ORIGIN || "http://localhost:4321";
const BASE_URL = `${APP_ORIGIN}${BASE_PATH}`;
const DEV_PORT = new URL(APP_ORIGIN).port || "4321";

const config = {
  testDir: "./tests",
  // Only e2e specs. Bun unit tests live in tests/unit/*.test.ts and must not be picked up here.
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  // Playwright defaults to half the machine's cores, which made the suite's
  // result depend on the machine: on a 20-core host that is 10 parallel
  // browsers, and full-suite runs there failed anywhere from 4 to 26 tests,
  // almost all of them "the DuckDB bridge never became ready" — each browser
  // boots its own 44MB DuckDB-WASM and then queries one shared single-process
  // VGI worker. At 4 and at 2 the same run failed only the genuinely broken
  // tests, twice each. This is a ceiling, not a target: PLAYWRIGHT_WORKERS
  // overrides it.
  workers: Number(process.env.PLAYWRIGHT_WORKERS) || 4,
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  webServer: {
    command: `bun run dev -- --port ${DEV_PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
};

export default config;
