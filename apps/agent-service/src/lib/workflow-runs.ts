import { and, eq } from "drizzle-orm";
import { createError } from "h3";
import { workflowRuns } from "@eloquio/db-schema";
import { getDb } from "./db.js";

/**
 * Records the owner of a freshly-started workflow run so reattach GETs
 * can verify the calling user is allowed to read its event stream.
 * Called at start time from each POST route, after `start()` returns
 * the runId. Failure here is fatal for the request — better to refuse
 * than to leave an unguarded run-id alive.
 */
export async function recordRunOwner(input: {
  runId: string;
  userId: string;
  conversationId?: string;
}): Promise<void> {
  const db = getDb();
  await db.insert(workflowRuns).values({
    runId: input.runId,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
  });
}

/**
 * Owner-guards a runId against the calling user. Throws a 404 (rather
 * than 403) when the calling user doesn't own the run, so we don't leak
 * the existence of someone else's runId. Throws 404 when the run isn't
 * recorded at all (pre-migration runs, or a window where the workflow
 * started but the row hadn't committed — that's caller's problem to
 * retry, not ours to expose).
 */
export async function assertRunOwner(input: {
  runId: string;
  userId: string;
}): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ userId: workflowRuns.userId })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.runId, input.runId),
        eq(workflowRuns.userId, input.userId),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Run not found" });
  }
}
