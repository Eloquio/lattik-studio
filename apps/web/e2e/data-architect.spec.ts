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
});
