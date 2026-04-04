import { test, expect } from "./fixtures";

test.describe("Chat", () => {
  test("home page loads after auth", async ({ authenticatedPage: page }) => {
    await expect(page.getByText("Start a conversation...")).toBeVisible();
    await expect(page.getByPlaceholder("Type something...")).toBeVisible();
  });

  test("send a message and receive AI response", async ({ authenticatedPage: page }) => {
    const textarea = page.getByPlaceholder("Type something...");
    await textarea.fill("Say hello in exactly 3 words");
    await textarea.press("Enter");

    // Wait for user message to appear
    await expect(page.getByText("Say hello in exactly 3 words")).toBeVisible();

    // Wait for assistant response — look for the agent label and response content
    const assistantResponses = page.locator('[class*="border-l-2"]');
    await expect(assistantResponses.first()).toBeVisible({ timeout: 15_000 });

    // Verify response has actual text content (not empty)
    const responseText = await assistantResponses.first().textContent();
    expect(responseText?.trim().length).toBeGreaterThan(0);
  });

  test("conversation persists after refresh", async ({ authenticatedPage: page }) => {
    const textarea = page.getByPlaceholder("Type something...");
    await textarea.fill("Remember: purple elephant 42");
    await textarea.press("Enter");

    // Wait for assistant response to finish
    const assistantResponses = page.locator('[class*="border-l-2"]');
    await expect(assistantResponses.first()).toBeVisible({ timeout: 15_000 });

    // Wait for auto-save (triggers when status goes to "ready")
    await page.waitForTimeout(2_000);

    // Refresh the page
    await page.reload();

    // Conversation should be restored from DB (use first() since text appears in title bar and message)
    await expect(page.getByText("purple elephant 42").first()).toBeVisible({ timeout: 10_000 });
  });
});
