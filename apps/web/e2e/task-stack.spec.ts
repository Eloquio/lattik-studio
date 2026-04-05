import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/** Fill textarea and wait for send button to be enabled (stream finished), then send. */
async function sendMessage(page: Page, text: string) {
  const textarea = page.getByPlaceholder("Type something...");
  const sendButton = page.locator("button").filter({ has: page.locator('svg.lucide-arrow-up') });

  // Fill the textarea
  await textarea.fill(text);

  // Wait for the send button to be enabled (means stream is done and input is non-empty)
  await expect(sendButton).toBeEnabled({ timeout: 60_000 });

  // Send
  await textarea.press("Enter");
}

test.describe("Task Stack", () => {
  test("specialist suggests finishing current task on off-topic message", async ({
    authenticatedPage: page,
  }) => {
    test.setTimeout(120_000);

    const assistantResponses = page.locator('[class*="border-l-2"]');

    // Step 1: Trigger handoff to Data Architect
    await sendMessage(page, "I want to design a logger table called page_views for tracking page views");

    // Wait for the Data Architect label to appear in a message (handoff complete)
    await expect(page.getByText("Data Architect").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(assistantResponses.last()).toBeVisible({ timeout: 30_000 });

    // Step 2: Send an off-topic message — Data Architect should suggest finishing first
    const countBefore = await assistantResponses.count();
    await sendMessage(page, "What is the weather like today?");

    // Wait for a new response to appear
    await expect(async () => {
      const count = await assistantResponses.count();
      expect(count).toBeGreaterThan(countBefore);
    }).toPass({ timeout: 30_000 });

    // The header should still show Data Architect (no pause happened)
    await expect(
      page.locator('[class*="border-b"]').getByText("Data Architect")
    ).toBeVisible();
  });

  test("full pause and resume cycle", async ({
    authenticatedPage: page,
  }) => {
    test.setTimeout(300_000);

    const assistantResponses = page.locator('[class*="border-l-2"]');

    // Step 1: Trigger handoff to Data Architect
    await sendMessage(page, "I need to design a logger table called checkout_events for tracking e-commerce checkouts");

    // Wait for handoff to complete
    await expect(page.getByText("Data Architect").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(assistantResponses.last()).toBeVisible({ timeout: 30_000 });

    // Step 2: Insist on pausing
    const assistantLabelsBefore = await page
      .locator("span")
      .filter({ hasText: /^Assistant$/ })
      .count();

    await sendMessage(page, "I insist on pausing this task right now. Please hand me back to the main assistant immediately.");

    // Wait for the pause handoff — a new "Assistant" label should appear
    await expect(async () => {
      const currentCount = await page
        .locator("span")
        .filter({ hasText: /^Assistant$/ })
        .count();
      expect(currentCount).toBeGreaterThan(assistantLabelsBefore);
    }).toPass({ timeout: 60_000 });

    // Step 3: Have the assistant handle a simple request
    const countBeforeQuestion = await assistantResponses.count();
    await sendMessage(page, "What is Lattik Studio? Answer in one sentence.");

    // Wait for a new response
    await expect(async () => {
      const count = await assistantResponses.count();
      expect(count).toBeGreaterThan(countBeforeQuestion);
    }).toPass({ timeout: 30_000 });

    // Step 4: Tell the assistant we're done to trigger stack pop
    const dataArchitectCountBefore = await page
      .locator("span")
      .filter({ hasText: "Data Architect" })
      .count();

    await sendMessage(page, "That's all, nothing else. I'm done with this question.");

    // Wait for Data Architect to resume — its label count should increase
    await expect(async () => {
      const currentCount = await page
        .locator("span")
        .filter({ hasText: "Data Architect" })
        .count();
      expect(currentCount).toBeGreaterThan(dataArchitectCountBefore);
    }).toPass({ timeout: 60_000 });
  });

  test("task stack persists after page reload", async ({
    authenticatedPage: page,
  }) => {
    test.setTimeout(120_000);

    const assistantResponses = page.locator('[class*="border-l-2"]');

    // Step 1: Trigger handoff to Data Architect
    await sendMessage(page, "Design a logger table called session_events to track user sessions");

    // Wait for handoff to complete
    await expect(page.getByText("Data Architect").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(assistantResponses.last()).toBeVisible({ timeout: 30_000 });

    // Step 2: Force a pause handoff
    const assistantLabelsBefore = await page
      .locator("span")
      .filter({ hasText: /^Assistant$/ })
      .count();

    await sendMessage(page, "I insist on pausing this task right now. Hand me to the main assistant.");

    // Wait for assistant to take over (new Assistant label appears)
    await expect(async () => {
      const currentCount = await page
        .locator("span")
        .filter({ hasText: /^Assistant$/ })
        .count();
      expect(currentCount).toBeGreaterThan(assistantLabelsBefore);
    }).toPass({ timeout: 60_000 });

    // Wait for auto-save
    await page.waitForTimeout(3_000);

    // Step 3: Reload the page
    await page.reload();

    // Conversation should be restored
    await expect(page.getByText("session_events").first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
