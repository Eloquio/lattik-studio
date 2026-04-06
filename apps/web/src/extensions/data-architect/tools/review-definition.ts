import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";

export interface ReviewSuggestion {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "error";
}

export const reviewDefinitionTool = {
  description:
    "Generate AI review suggestions for a definition. Returns a list of suggestions the user can accept or deny. The suggestions are rendered as interactive cards in the chat panel — the user will respond with their decisions.",
  inputSchema: zodSchema(
    z.object({
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .describe("The type of definition being reviewed"),
      specJson: z
        .string()
        .describe("JSON string of the definition spec to review"),
      suggestions: z
        .array(
          z.object({
            id: z.string().describe("Unique suggestion ID, e.g. 'missing_desc'"),
            title: z.string().describe("Short title for the suggestion"),
            description: z.string().describe("Explanation of the suggestion"),
            severity: z.enum(["info", "warning", "error"]).describe("Severity level"),
          })
        )
        .describe("List of review suggestions to present to the user"),
    })
  ),
  execute: async (input: {
    kind: DefinitionKind;
    specJson: string;
    suggestions: ReviewSuggestion[];
  }) => {
    let spec: unknown;
    try {
      spec = JSON.parse(input.specJson);
    } catch {
      return { error: "Invalid JSON in specJson" };
    }
    return {
      kind: input.kind,
      spec,
      suggestions: input.suggestions,
      instruction:
        "Suggestions are now displayed as interactive cards in the chat. IMPORTANT: Do NOT output any spec code fences in your response — the canvas form must remain unchanged. Wait for the user to accept or deny each suggestion — they will respond with their decisions. Then apply accepted changes to the definition.",
    };
  },
};
