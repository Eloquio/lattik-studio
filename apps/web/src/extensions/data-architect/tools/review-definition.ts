import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";

export const reviewDefinitionTool = {
  description:
    "Generate AI review suggestions for a definition. Returns a list of suggestions the user can accept or deny. The agent should analyze the definition and provide improvements, warnings, and best practices.",
  inputSchema: zodSchema(
    z.object({
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .describe("The type of definition being reviewed"),
      specJson: z
        .string()
        .describe("JSON string of the definition spec to review"),
    })
  ),
  execute: async (input: { kind: DefinitionKind; specJson: string }) => {
    let spec: unknown;
    try {
      spec = JSON.parse(input.specJson);
    } catch {
      return { error: "Invalid JSON in specJson" };
    }
    return {
      kind: input.kind,
      spec,
      instruction:
        "Analyze this definition and provide suggestions. For each suggestion, use renderCanvas to show a ReviewCard component with suggestionId, title, description, and severity (info/warning/error).",
    };
  },
};
