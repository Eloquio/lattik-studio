import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";
import { validate } from "../validation";
import { canvasStateToSpec } from "../canvas-to-spec";

export function createStaticCheckTool(getCanvasState: () => unknown) {
  return {
    description:
      "Run static validation checks on the definition currently rendered on the canvas. Reads the canvas form state directly — do NOT pass a spec. Validates naming conventions, required fields, referential integrity, and expression syntax. Returns pass/fail with error details.",
    inputSchema: zodSchema(
      z.object({
        kind: z
          .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
          .describe("The type of definition currently on the canvas"),
      })
    ),
    execute: async (input: { kind: DefinitionKind }) => {
      const spec = canvasStateToSpec(input.kind, getCanvasState());
      return await validate(input.kind, spec);
    },
  };
}
