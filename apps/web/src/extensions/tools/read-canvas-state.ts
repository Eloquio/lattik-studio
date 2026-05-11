import { zodSchema } from "ai";
import { z } from "zod";

/**
 * Framework helper for the per-extension `readCanvasState` tool. Every
 * extension owns its own projection (sanitize duplicates, extract specific
 * fields, raw passthrough), but the surrounding scaffolding — description,
 * empty input schema, dispatch — should live in one place.
 *
 * The agent sees the value `project(rawSpec)` returns. Extensions decide
 * the shape of that value.
 */
export function createReadCanvasStateTool<T>({
  description,
  getCanvasState,
  project,
}: {
  description: string;
  getCanvasState: () => unknown;
  project: (rawSpec: unknown) => T;
}) {
  return {
    description,
    inputSchema: zodSchema(z.object({})),
    execute: async () => project(getCanvasState()),
  };
}
