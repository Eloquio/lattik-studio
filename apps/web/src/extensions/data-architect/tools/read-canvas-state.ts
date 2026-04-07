import { zodSchema } from "ai";
import { z } from "zod";
import { sanitizeCanvasFormState } from "../canvas-to-spec";

export function createReadCanvasStateTool(getCanvasState: () => unknown) {
  return {
    description:
      "Read the current canvas form state. Returns the state object with field values the user has filled in or modified on the canvas.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      // Sanitize the form state before returning it. The underlying canvas
      // state can occasionally accumulate stream-loop garbage (e.g. hundreds
      // of duplicate column entries from a flaky agent render), but the
      // display layer dedupes that for the user. We must show the LLM the
      // same view the user sees — otherwise the agent reads the bloated
      // state, concludes "the canvas is broken", and spirals into a recovery
      // loop trying to "fix" duplicates that the user can't see.
      const rawSpec = getCanvasState();
      const sanitizedFormState = sanitizeCanvasFormState(rawSpec);
      const baseSpec =
        rawSpec && typeof rawSpec === "object"
          ? (rawSpec as Record<string, unknown>)
          : {};
      return {
        canvasState: { ...baseSpec, state: sanitizedFormState },
      };
    },
  };
}
