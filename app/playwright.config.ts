import { defineConfig, devices } from "@playwright/test";

const acceptanceMode = process.env.ACCEPTANCE_MODE ?? "field";
const acceptancePort = Number(process.env.ACCEPTANCE_PORT ?? process.env.PORT ?? "4173");
const acceptanceBaseUrl = `http://127.0.0.1:${acceptancePort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: acceptanceBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "dark-chromium",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "node scripts/acceptance-server.mjs",
    env: {
      ...process.env,
      ACCEPTANCE_MODE: acceptanceMode,
      PORT: String(acceptancePort),
    },
    url: `${acceptanceBaseUrl}/healthz`,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI && acceptanceMode === "field",
  },
});
