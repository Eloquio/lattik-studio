/**
 * Shared zod helpers for run queue + lattik API route handlers.
 *
 * `parseJsonBody` does the two things every route needs: read JSON from the
 * Request (returning a 400 if the body isn't valid JSON), and validate it
 * against a schema (returning a 400 with issue details if validation fails).
 * On success it returns the parsed object; on failure it returns a ready-
 * to-return Response so the caller can `if (body instanceof Response)`.
 */

import { z } from "zod";

export const MAX_LIMIT = 500;

export const runStatusSchema = z.enum([
  "draft",
  "pending",
  "claimed",
  "done",
  "failed",
]);

export const requestStatusSchema = z.enum([
  "pending",
  "planning",
  "awaiting_approval",
  "approved",
  "done",
  "failed",
]);

export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: "Request body is not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid request body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  return parsed.data;
}
