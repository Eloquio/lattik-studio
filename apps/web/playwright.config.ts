import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "html",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Only start webServer in CI or when no existing server is running.
  // Locally, run `pnpm dev:test` manually or set E2E_BASE_URL to your running server.
  ...(process.env.CI
    ? {
        webServer: {
          command: "pnpm dev:test",
          url: baseURL,
          timeout: 30_000,
          env: {
            NODE_ENV: "test",
            AUTH_URL: baseURL,
          },
        },
      }
    : {}),
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
});
