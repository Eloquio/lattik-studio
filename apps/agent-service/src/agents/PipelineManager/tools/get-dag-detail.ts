import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Phase 1 stub — real implementation pending. */
export const getDagDetailTool = tool({
  description:
    "Fetch a DAG's structure, schedule, and the linked Lattik Table spec from the definitions DB.",
  inputSchema: zodSchema(
    z.object({
      dagId: z.string().describe("DAG id (e.g. 'lattik_table_user_events')"),
    }),
  ),
  execute: async (input: { dagId: string }) => ({
    stub: true,
    note: "Real implementation pending — moves from apps/web in a follow-up slice.",
    dagId: input.dagId,
  }),
});
