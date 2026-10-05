import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: "release-lifecycle.spec.ts", workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://localhost:4333" },
  webServer: { command: "bun scripts/preview-release.ts", url: "http://localhost:4333/release.json", timeout: 30_000 },
});
