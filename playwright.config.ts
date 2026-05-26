import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);
const BASE_PATH = `/v${pkg.version}/`;
const BASE_URL = `http://localhost:4321${BASE_PATH}`;

const config = {
  testDir: "./tests",
  // Only e2e specs. Bun unit tests live in tests/unit/*.test.ts and must not be picked up here.
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  webServer: {
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
};

export default config;
