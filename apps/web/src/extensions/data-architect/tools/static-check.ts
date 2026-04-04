import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";
import { validate } from "../validation";

export const staticCheckTool = {
  description:
    "Run static validation checks on a definition. Validates naming conventions, required fields, referential integrity, and expression syntax. Returns pass/fail with error details.",
  inputSchema: zodSchema(
    z.object({
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .describe("The type of definition to validate"),
      specJson: z
        .string()
        .describe("JSON string of the definition spec to validate"),
    })
  ),
  execute: async (input: { kind: DefinitionKind; specJson: string }) => {
    let spec: unknown;
    try {
      spec = JSON.parse(input.specJson);
    } catch {
      return { passed: false, errors: [{ field: "specJson", message: "Invalid JSON" }] };
    }
    const result = await validate(input.kind, spec);
    return result;
  },
};
