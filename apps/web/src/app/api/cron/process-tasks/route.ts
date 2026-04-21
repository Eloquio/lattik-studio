import { timingSafeEqual } from "node:crypto";
import {
  claimRequest,
  claimTask,
  createTask,
  autoApproveRequest,
  submitRequestForApproval,
  resetStaleRequests,
} from "@/lib/task-queue";
import { loadSkills, findSkill, instantiateSkill } from "@/lib/skills";

const BATCH_LIMIT = 10;

/**
 * Cron-triggered task processor. Runs every minute.
 *
 * Phase 1: Plan — claim pending requests, match skills, create tasks
 * Phase 2: Execute — claim pending tasks, invoke agents (placeholder)
 * Phase 3: Cleanup — check if completed requests can be marked done
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

  const stats = { planned: 0, executed: 0, completed: 0, failed: 0, staleRequestsReleased: 0 };

  // Phase 0: Release requests whose planning-claim has expired. Must run
  // before the plan pass so any released row is immediately eligible to be
  // re-claimed in this same cron tick.
  stats.staleRequestsReleased = await resetStaleRequests();

  // Phase 1: Plan — claim pending requests and create tasks from skills
  const skills = loadSkills();
  for (let i = 0; i < BATCH_LIMIT; i++) {
    const request = await claimRequest("system-planner");
    if (!request) break;

    try {
      const context = request.context as Record<string, unknown> | null;

      // Check if a skill is explicitly referenced in the context
      const skillName = context?.skill as string | undefined;
      const skill = skillName ? findSkill(skills, skillName) : undefined;

      if (skill) {
        // Instantiate tasks from skill template
        const args = (context?.args as Record<string, unknown>) ?? context ?? {};
        const taskDefs = instantiateSkill(skill, args);

        for (const def of taskDefs) {
          await createTask(
            request.id,
            def.agentId,
            def.description,
            def.doneCriteria
          );
        }

        if (skill.auto_approve) {
          await autoApproveRequest(request.id);
        } else {
          await submitRequestForApproval(request.id);
        }
      } else {
        // No skill match — submit for human planning
        // In the future, the planner LLM agent will handle this
        await submitRequestForApproval(request.id);
      }

      stats.planned++;
    } catch (err) {
      console.error(`Failed to plan request ${request.id}:`, err);
      stats.failed++;
    }
  }

  // Phase 2: Execute — pending tasks are claimed by the agent worker process
  // (apps/agent-worker). The cron job resets stale tasks via claimTask internals.
  // Trigger a single no-op claim to run the stale reset logic.
  await claimTask({ claimedBy: "cron-stale-reset" });

  return Response.json({ status: "ok", ...stats });
}
