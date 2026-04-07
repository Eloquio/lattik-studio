import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";
import {
  createDefinition,
  updateDefinition,
  getDefinitionByName,
} from "@/lib/actions/definitions";
import {
  canvasStateToSpec,
  getDefinitionNameFromCanvas,
} from "../canvas-to-spec";

export function createUpdateDefinitionTool(getCanvasState: () => unknown) {
  return {
    description:
      "Save or update a definition in the database as a draft, using the current canvas form state as the source of truth. The name and spec are read directly from the canvas — do NOT pass them. If a definition with the same kind and name exists, it will be updated; otherwise a new draft is created.",
    inputSchema: zodSchema(
      z.object({
        kind: z
          .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
          .describe("The type of definition currently on the canvas"),
      })
    ),
    execute: async (input: { kind: DefinitionKind }) => {
      const canvasState = getCanvasState();
      const name = getDefinitionNameFromCanvas(canvasState);
      if (!name) {
        return { error: "Canvas form has no name field set — fill it in before saving." };
      }
      const spec = canvasStateToSpec(input.kind, canvasState);

      try {
        const existing = await getDefinitionByName(input.kind, name);
        if (existing) {
          const updated = await updateDefinition(existing.id, { spec });
          return { action: "updated", id: updated.id, name, kind: input.kind };
        }

        const created = await createDefinition({
          kind: input.kind,
          name,
          spec,
        });
        return { action: "created", id: created.id, name, kind: input.kind };
      } catch (error) {
        // Handle unique constraint violation (race condition)
        if (error instanceof Error && error.message.includes("unique")) {
          const existing = await getDefinitionByName(input.kind, name);
          if (existing) {
            const updated = await updateDefinition(existing.id, { spec });
            return { action: "updated", id: updated.id, name, kind: input.kind };
          }
        }
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
