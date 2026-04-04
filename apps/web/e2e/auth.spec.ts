import { test, expect } from "./fixtures";

test.describe("Authentication", () => {
  test("sign-in page loads", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByText("Lattik")).toBeVisible();
    await expect(page.getByText("Studio")).toBeVisible();
    await expect(page.getByText("Sign in to continue")).toBeVisible();
  });

  test("unauthenticated user is redirected to sign-in", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/sign-in/, { timeout: 10_000 });
    await expect(page.getByText("Sign in to continue")).toBeVisible();
  });

  test("authenticated user sees home page", async ({ authenticatedPage }) => {
    await expect(authenticatedPage.getByText("Start a conversation...")).toBeVisible();
    await expect(authenticatedPage.getByPlaceholder("Type something...")).toBeVisible();
  });
});
