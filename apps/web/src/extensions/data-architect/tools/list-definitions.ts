import { zodSchema } from "ai";
import { z } from "zod";
import { listDefinitions, listMergedDefinitions } from "@/lib/actions/definitions";

export const listDefinitionsTool = {
  description:
    "List existing definitions, optionally filtered by kind and/or status. Use this to check what entities, tables, dimensions, and metrics already exist.",
  inputSchema: zodSchema(
    z.object({
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .optional()
        .describe("Filter by definition kind"),
      mergedOnly: z
        .boolean()
        .optional()
        .describe("If true, only return merged (production) definitions"),
    })
  ),
  execute: async (input: { kind?: string; mergedOnly?: boolean }) => {
    const defs = input.mergedOnly
      ? await listMergedDefinitions(input.kind as any)
      : await listDefinitions(input.kind as any);

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
