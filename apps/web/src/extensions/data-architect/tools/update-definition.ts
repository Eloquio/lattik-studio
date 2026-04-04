import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";
import {
  createDefinition,
  updateDefinition,
  getDefinitionByName,
} from "@/lib/actions/definitions";

export const updateDefinitionTool = {
  description:
    "Save or update a definition in the database as a draft. If a definition with the same kind and name exists, it will be updated. Otherwise, a new draft is created.",
  inputSchema: zodSchema(
    z.object({
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .describe("The type of definition"),
      name: z.string().describe("The name of the definition"),
      specJson: z
        .string()
        .describe("JSON string of the complete definition spec"),
    })
  ),
  execute: async (input: {
    kind: DefinitionKind;
    name: string;
    specJson: string;
  }) => {
    let spec: unknown;
    try {
      spec = JSON.parse(input.specJson);
    } catch {
      return { error: "Invalid JSON in specJson" };
    }

    try {
      const existing = await getDefinitionByName(input.kind, input.name);
      if (existing) {
        const updated = await updateDefinition(existing.id, { spec });
        return { action: "updated", id: updated.id, name: input.name, kind: input.kind };
      }

      const created = await createDefinition({
        kind: input.kind,
        name: input.name,
        spec,
      });
      return { action: "created", id: created.id, name: input.name, kind: input.kind };
    } catch (error) {
      // Handle unique constraint violation (race condition)
      if (error instanceof Error && error.message.includes("unique")) {
        const existing = await getDefinitionByName(input.kind, input.name);
        if (existing) {
          const updated = await updateDefinition(existing.id, { spec });
          return { action: "updated", id: updated.id, name: input.name, kind: input.kind };
        }
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};
