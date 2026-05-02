/**
 * SSE endpoint that streams step events for a run as they land.
 *
 * The UI's `EventSource` opens this and gets:
 *   - on connect: a snapshot of all existing step rows (event: `snapshot`),
 *   - then: one `step` event per new row, in sequence order,
 *   - finally: a `done` event when the run reaches a terminal state.
 *
 * Implementation polls Postgres every ~500ms for rows newer than the last
 * sequence we've shipped. Cheap for local dev with a handful of concurrent
 * runs; upgrade to LISTEN/NOTIFY if you need lower latency or higher
 * concurrency in prod.
 */

import { gt, eq, asc, and } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

const POLL_INTERVAL_MS = 500;
// Hard cap on connection lifetime — nothing should keep a stream open
// longer than this. Run wall-clock is bounded by the worker's stale-claim
// timeout (5 minutes) plus a buffer.
const MAX_DURATION_MS = 10 * 60 * 1000;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  await requireUser();
  const { id: runId } = await ctx.params;
  const db = getDb();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // Snapshot existing rows up front so the UI doesn't flash empty.
      const initial = await db
        .select()
        .from(schema.steps)
        .where(eq(schema.steps.runId, runId))
        .orderBy(asc(schema.steps.sequence));
      send("snapshot", initial);

      let lastSeq = initial.at(-1)?.sequence ?? -1;
      const startedAt = Date.now();
      let running = true;

      req.signal?.addEventListener("abort", () => {
        running = false;
      });

      while (running && Date.now() - startedAt < MAX_DURATION_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (!running) break;

        const fresh = await db
          .select()
          .from(schema.steps)
          .where(
            and(
              eq(schema.steps.runId, runId),
              gt(schema.steps.sequence, lastSeq),
            ),
          )
          .orderBy(asc(schema.steps.sequence));
        for (const row of fresh) {
          send("step", row);
          lastSeq = row.sequence;
        }

        // Check whether the run itself has terminated. If yes, send a
        // `done` event and close the stream so the client tears down its
        // EventSource cleanly.
        const [runRow] = await db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId));
        if (
          runRow &&
          (runRow.status === "done" || runRow.status === "failed")
        ) {
          send("done", { status: runRow.status });
          break;
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
