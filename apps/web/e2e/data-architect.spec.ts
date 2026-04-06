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

    // Wait for the Handoff tool to complete
    await expect(page.getByText("Handoff").first()).toBeVisible({
      timeout: 30_000,
    });

    // The Data Architect agent should respond — its label appears as a
    // separate text element (distinct from the "Data Architect" header)
    const agentLabels = page.locator("span", { hasText: "Data Architect" });
    await expect(agentLabels).toHaveCount(2, { timeout: 30_000 });

    // Verify the Data Architect calls getSkill (loads its skill document)
    await expect(page.getByText("Get Skill").first()).toBeVisible({
      timeout: 30_000,
    });

    // Verify no error banner appeared during the handoff
    const errorBanner = page.locator('[class*="border-red"]');
    await expect(errorBanner).toHaveCount(0);
  });

  test("Review Table button sends message to chat", async ({
    authenticatedPage: page,
  }) => {
    test.setTimeout(120_000);

    const textarea = page.getByPlaceholder("Type something...");
    const sendButton = page.locator("button").filter({ has: page.locator("svg.lucide-arrow-up") });

    // Step 1: Trigger handoff to Data Architect and wait for canvas to render
    await textarea.fill(
      "I want to design a new logger table called signup_events to track user signups"
    );
    await textarea.press("Enter");

    // Wait for the Data Architect to render the LoggerTableForm on the canvas
    const reviewButton = page.getByRole("button", { name: "Review Table" });
    await expect(reviewButton).toBeVisible({ timeout: 60_000 });

    // Wait for the agent stream to finish: type a character so the send
    // button's only remaining disable condition is isLoading, then wait for
    // it to become enabled, and clear the input before proceeding.
    await textarea.fill(".");
    await expect(sendButton).toBeEnabled({ timeout: 60_000 });
    await textarea.fill("");

    // Step 2: Click the Review Table button
    await reviewButton.click();

    // Step 3: Verify "Review table" appears as a user message in the chat
    // User messages are right-aligned in a div with justify-end
    const userMessage = page.locator("div.justify-end").filter({ hasText: "Review table" });
    await expect(userMessage).toBeVisible({ timeout: 10_000 });
  });
});
