import { zodSchema } from "ai";
import { z } from "zod";

export function createReadCanvasStateTool(getCanvasState: () => unknown) {
  return {
    description:
      "Read the current canvas form state. Returns the state object with field values the user has filled in or modified on the canvas.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const state = getCanvasState();
      return { canvasState: state ?? {} };
    },
  };
}
