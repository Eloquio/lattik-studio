import { zodSchema } from "ai";
import { z } from "zod";

export function createReadCanvasStateTool(getCanvasState: () => unknown) {
  return {
    description:
      "Read the current canvas state. Returns the state object with any user selections (e.g. selectedDagId, selectedTaskId).",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const rawSpec = getCanvasState();
      const baseSpec =
        rawSpec && typeof rawSpec === "object"
          ? (rawSpec as Record<string, unknown>)
          : {};
      return {
        canvasState: baseSpec,
      };
    },
  };
}
