import {
  claimRequest,
  claimTask,
  createTask,
  completeTask,
  failTask,
  autoApproveRequest,
  submitRequestForApproval,
  tryCompleteRequest,
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
  // Verify cron secret (Vercel sets this header automatically)
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stats = { planned: 0, executed: 0, completed: 0, failed: 0 };

  // Phase 1: Plan — claim pending requests and create tasks from skills
  const skills = loadSkills();
  for (let i = 0; i < BATCH_LIMIT; i++) {
    const request = await claimRequest("cron-planner");
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
