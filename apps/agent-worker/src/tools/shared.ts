/**
 * Shared base output schema for executor-side tools.
 *
 * Every tool returns at minimum `{ ok: boolean }`. The UI flowchart's
 * status classifier keys off `ok` (and `not_implemented` for stubs that
 * are expected to be pending, not red errors). Tools extend this with
 * tool-specific fields via `toolOutputSchema(z.object({...}))`.
 */

import { z } from "zod";

export const baseOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  not_implemented: z.boolean().optional(),
});

export type BaseToolOutput = z.infer<typeof baseOutputSchema>;

/**
 * Compose the base output with tool-specific fields. Extra fields are
 * merged at the top level so the result still satisfies the base shape.
 */
export function toolOutputSchema<T extends z.ZodRawShape>(
  extra: z.ZodObject<T>,
) {
  return baseOutputSchema.merge(extra);
}
