import { requireBearer } from "@/lib/bearer-auth";
import { log } from "@/lib/log";
import { runSchedulerTick } from "@/lib/dag-scheduler";

/**
 * GET /api/scheduler/tick — invoked by Vercel Cron every minute.
 *
 * Vercel signs cron invocations with `Authorization: Bearer $CRON_SECRET`,
 * which `requireBearer` validates. Returns the per-tick counters as JSON
 * for observability.
 */
export async function GET(req: Request) {
  const denial = requireBearer(req, "CRON_SECRET");
  if (denial) return denial;

  try {
    const result = await runSchedulerTick();
    log.info("scheduler_tick.done", result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("scheduler_tick.failed", { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
