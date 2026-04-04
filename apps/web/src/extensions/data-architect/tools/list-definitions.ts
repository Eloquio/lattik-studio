import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";
import { listDefinitions, listMergedDefinitions } from "@/lib/actions/definitions";

const definitionKindEnum = z.enum([
  "entity", "dimension", "logger_table", "lattik_table", "metric",
]);

export const listDefinitionsTool = {
  description:
    "List existing definitions, optionally filtered by kind and/or status. Use this to check what entities, tables, dimensions, and metrics already exist.",
  inputSchema: zodSchema(
    z.object({
      kind: definitionKindEnum
        .optional()
        .describe("Filter by definition kind"),
      mergedOnly: z
        .boolean()
        .optional()
        .describe("If true, only return merged (production) definitions"),
    })
  ),
  execute: async (input: { kind?: DefinitionKind; mergedOnly?: boolean }) => {
    const defs = input.mergedOnly
      ? await listMergedDefinitions(input.kind)
      : await listDefinitions(input.kind);

    return {
      count: defs.length,
      definitions: defs.map((d) => ({
        id: d.id,
        kind: d.kind,
        name: d.name,
        version: d.version,
        status: d.status,
        updatedAt: d.updatedAt,
      })),
    };
  },
};
