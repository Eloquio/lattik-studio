import { test, expect } from "./fixtures";

test.describe("Data Architect", () => {
  test("handoff to Data Architect on pipeline question", async ({
    authenticatedPage: page,
  }) => {
    const textarea = page.getByPlaceholder("Type something...");

    // Send a clear data architecture request to trigger handoff
    await textarea.fill(
      "I want to design a new logger table called user_click_events to track user clicks on the platform"
    );
    await textarea.press("Enter");

    // Wait for the handoff — "Data Architect" label should appear
    await expect(page.getByText("Data Architect").first()).toBeVisible({
      timeout: 30_000,
    });

    // The Data Architect agent should respond with something about the table
    const assistantResponses = page.locator('[class*="border-l-2"]');
    await expect(assistantResponses.last()).toBeVisible({ timeout: 30_000 });
  });
});
