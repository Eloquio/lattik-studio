import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";

export interface ReviewAction {
  path: string;
  value: unknown;
}

export interface ReviewSuggestion {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "error";
  actions?: ReviewAction[];
}

export const reviewDefinitionTool = {
  description:
    "Generate AI review suggestions for a definition. Suggestions are rendered as interactive cards in the chat. When the user accepts a suggestion with actions, the changes are applied directly to the canvas — no chat message is sent.",
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
            actions: z
              .array(
                z.object({
                  path: z.string().describe("JSON Pointer path to the canvas state field, e.g. '/description'"),
                  value: z.unknown().describe("The value to set at this path"),
                })
              )
              .optional()
              .describe("State patches to apply when accepted. Use canvas state paths like /description, /user_columns, etc. If omitted, accepting records the decision but does not change the canvas."),
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
        "Suggestions are displayed as interactive cards in the chat. When the user accepts a suggestion with actions, the changes are applied directly to the canvas — no chat message is needed. IMPORTANT: Do NOT output any spec code fences in your response. Include concrete `actions` on each suggestion so the change can be applied instantly (e.g. actions: [{path: '/description', value: 'Tracks user click events'}]).",
    };
  },
};
