import { tool, zodSchema, type Tool, type ToolCallOptions } from "ai";
import type { z } from "zod";

/**
 * Wrapper around the AI SDK's `tool()` that enforces a strict input schema.
 *
 * Background: zod's default `z.object({...})` silently strips unknown keys
 * during validation. When an LLM tool-calls with an adjacent-but-wrong key
 * (e.g. `columns` instead of `user_columns`, `dedup` instead of
 * `dedup_window`), the wrong key disappears, the tool's `execute` runs with
 * partial input, the canvas renders an empty form, and no error surfaces
 * anywhere — the failure is invisible to both the model and the UI.
 *
 * `strictTool` runs `.strict()` on the top-level zod object before
 * wrapping it via `zodSchema(...)`. The resulting JSON Schema has
 * `additionalProperties: false`, so unknown keys cause the AI SDK's input
 * validator to throw `InvalidToolInputError`. The agent loop catches that
 * error, feeds it back to the model as the tool result, and the model
 * self-corrects on the next iteration.
 *
 * Pass a raw `z.ZodObject` schema — NOT `zodSchema(z.object(...))`. This
 * helper handles the wrapping, so callers don't accidentally pass a
 * pre-wrapped schema where strict mode can no longer be applied.
 *
 * Limitation: `.strict()` only applies to the *immediate* top-level shape.
 * Nested objects (array elements, union arms, optional sub-schemas) must
 * be strict at their definition site. The accompanying CI test
 * (`tool-strictness.test.ts`) walks every registered tool's emitted JSON
 * Schema and asserts `additionalProperties: false` everywhere — that's
 * the regression catcher for forgotten strict() calls in nested
 * positions.
 */

type StrictToolConfig<
  S extends z.ZodObject<z.ZodRawShape>,
  OUTPUT,
> = {
  description?: string;
  title?: string;
  inputSchema: S;
  execute?: (
    input: z.infer<S>,
    options: ToolCallOptions,
  ) => OUTPUT | Promise<OUTPUT>;
};

export function strictTool<
  S extends z.ZodObject<z.ZodRawShape>,
  OUTPUT = unknown,
>(config: StrictToolConfig<S, OUTPUT>): Tool<z.infer<S>, OUTPUT> {
  return tool({
    description: config.description,
    title: config.title,
    inputSchema: zodSchema(config.inputSchema.strict()),
    // Provider-level strict mode (OpenAI structured outputs etc.). Cheap
    // belt-and-suspenders — providers that don't support it ignore the
    // flag.
    strict: true,
    execute: config.execute,
  } as never) as Tool<z.infer<S>, OUTPUT>;
}
