import { timingSafeEqual } from "node:crypto";
import { claimRun, resetStaleRequests } from "@/lib/run-queue";

/**
 * Cron-triggered cleanup. Runs every minute.
 *
 * Plan-time work used to live here (claim pending requests, match a YAML
 * skill recipe, create tasks). That path is gone — planning now happens
 * inside the Worker Node's Planner Agent (Phase C). This cron only resets
 * stale claims so dead workers don't hold work forever.
 */
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET is not configured");
    return Response.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const presented = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(cronSecret, "utf8");
  if (
    presentedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(presentedBuf, expectedBuf)
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Release requests whose planning-claim has expired.
  const staleRequestsReleased = await resetStaleRequests();

  // Trigger task-level stale-reset. claimRun runs the reset SQL on every
  // call; passing a no-op claimer is the cheapest way to invoke it without
  // taking on a real task.
  await claimRun({ claimedBy: "cron-stale-reset" });

  return Response.json({ status: "ok", staleRequestsReleased });
}
