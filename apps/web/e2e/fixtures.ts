import { readFileSync } from "fs";
import { join } from "path";
import { test as base, type Page } from "@playwright/test";

// Read session token from file written by global-setup (cross-process)
const STATE_FILE = join(__dirname, ".test-state.json");
function getSessionToken(): string {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  return state.sessionToken;
}

// Detect cookie config based on protocol
function getCookieConfig(baseURL: string) {
  const url = new URL(baseURL);
  const isHttps = url.protocol === "https:";
  return {
    name: isHttps ? "__Secure-authjs.session-token" : "authjs.session-token",
    domain: url.hostname,
    secure: isHttps,
  };
}

export const test = base.extend<{
  authenticatedPage: Page;
}>({
  authenticatedPage: async ({ page, context, baseURL }, use) => {
    const sessionToken = getSessionToken();
    const cookieConfig = getCookieConfig(baseURL ?? "http://localhost:3100");

    await context.addCookies([
      {
        name: cookieConfig.name,
        value: sessionToken,
        domain: cookieConfig.domain,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: cookieConfig.secure,
      },
    ]);

    await page.goto("/");
    await page.waitForURL("/", { timeout: 10_000 });

    await use(page);
  },
});

export { expect } from "@playwright/test";
