const config = {
  testDir: "./tests",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:4321",
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:4321",
    reuseExistingServer: true,
    timeout: 30_000,
  },
};

export default config;
