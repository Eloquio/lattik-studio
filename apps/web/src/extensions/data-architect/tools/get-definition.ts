import { zodSchema } from "ai";
import { z } from "zod";
import { getDefinitionByName } from "@/lib/actions/definitions";
import type { DefinitionKind } from "@/db/schema";

export const getDefinitionTool = {
  description:
    "Fetch a specific definition by kind and name. Returns the full spec. Use this when the user wants to view or update an existing definition.",
  inputSchema: zodSchema(
    z.object({
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .describe("The type of definition"),
      name: z.string().describe("The name of the definition"),
    })
  ),
  execute: async (input: { kind: DefinitionKind; name: string }) => {
    const def = await getDefinitionByName(input.kind, input.name);
    if (!def) {
      return { found: false, message: `No ${input.kind} named '${input.name}' found` };
    }
    return {
      found: true,
      id: def.id,
      kind: def.kind,
      name: def.name,
      version: def.version,
      status: def.status,
      spec: def.spec,
      prUrl: def.prUrl,
      updatedAt: def.updatedAt,
    };
  },
};
