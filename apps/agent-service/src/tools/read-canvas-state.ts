import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * `readCanvasState` — chat-runtime-shared tool that exposes the current
 * canvas state to the agent (e.g. which row the user clicked).
 *
 * The runtime supplies the canvas state via a closure at agent-build
 * time. For Phase 1 this is `null` — the canvas-state event protocol
 * is part of Phase 3 (web migrates fully to render-intents). The tool
 * exists today so an agent's AGENT.md can declare it in `base_tools`
 * without runtime errors; it simply reports "no canvas state attached".
 */

export interface CreateReadCanvasStateToolOptions {
  /** Returns the current canvas state for this agent invocation, or null. */
  getCanvasState: () => unknown | null;
}

export function createReadCanvasStateTool(opts: CreateReadCanvasStateToolOptions) {
  return tool({
    description:
      "Read the current state of the canvas — selected rows, expanded panels, etc. Use this to react to the user's most recent canvas interaction.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const state = opts.getCanvasState();
      if (state === null || state === undefined) {
        return { canvasState: null, note: "No canvas attached to this conversation yet." };
      }
      return { canvasState: state };
    },
  });
}
