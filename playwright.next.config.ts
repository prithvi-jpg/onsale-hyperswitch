import { defineConfig, devices } from "@playwright/test"

const port = 4180

export default defineConfig({
  testDir: "./tests/next-e2e",
  outputDir: ".cache/playwright-next-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: ".cache/playwright-next-report", open: "never" },
    ],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `ONSALE_NODE22_BIN="${process.execPath}" ./scripts/native-node22.sh direct dev --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
