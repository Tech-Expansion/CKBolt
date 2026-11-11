import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

// Runs against a production build (`npm run build` first).
// Set PW_CHANNEL=msedge or chrome to use an installed browser instead of
// downloading one with `npx playwright install chromium`.
export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    // Pure TypeScript tests for codecs and quote maths; no browser.
    { name: "unit", testMatch: "**/unit/**/*.spec.ts" },
    {
      name: "desktop",
      testMatch: "**/e2e/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL },
    },
    {
      name: "mobile",
      testMatch: "**/e2e/**/*.spec.ts",
      use: { ...devices["Pixel 7"], channel: process.env.PW_CHANNEL },
    },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Next fills only undefined variables from .env files, so empty values keep a developer's .env.local (which may point
    // at the real hub with its secret) out of the tests. A run can still set them on purpose.
    env: {
      HUB_URL: process.env.HUB_URL ?? "",
      HUB_PROXY_SECRET: process.env.HUB_PROXY_SECRET ?? "",
      TRUST_PROXY: process.env.TRUST_PROXY ?? "",
      BTC_SIGNET_ESPLORA_URL: process.env.BTC_SIGNET_ESPLORA_URL ?? "",
    },
  },
});
