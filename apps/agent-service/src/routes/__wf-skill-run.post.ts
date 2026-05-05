import { defineEventHandler, readValidatedBody, createError } from "h3";
import { z } from "zod";
import { start } from "workflow/api";
import { runSkillWorkflow } from "../workflows/skill-run.js";

/**
 * Trigger a skill run as a Vercel Workflow. Replaces the agent-worker
 * pod's claim-and-run loop:
 *
 *   today: web inserts a Run row → worker pod polls /api/runs/claim →
 *          executor agent runs in the pod
 *   here:  caller POSTs this route → workflow runs the executor inline
 *
 * No queue table involvement (yet); the slice 2 webhook integration will
 * decide whether to keep the Run row purely for audit or drop it.
 *
 * Auth: trusted-client (same as /__wf-chat). The caller is apps/web (the
 * webhook handler / human-action paths), not the end user.
 */

const bodySchema = z.object({
  runId: z.string().min(1),
  skillId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

export default defineEventHandler(async (event) => {
  const auth = event.context.auth;
  if (!auth) {
    throw createError({
      statusCode: 500,
      statusMessage: "auth context missing — middleware not wired",
    });
  }

  const body = await readValidatedBody(event, (raw) =>
    bodySchema.safeParse(raw),
  );
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${body.error.message}`,
    });
  }

  const run = await start(runSkillWorkflow, [
    {
      runId: body.data.runId,
      skillId: body.data.skillId,
      args: body.data.args,
    },
  ]);

  // No `recordRunOwner` here — skill runs are system-triggered (webhook
  // handlers, scheduled jobs, etc.), not user-owned conversations. The
  // chat-side reattach pattern that needs ownership doesn't apply.

  // Block until the workflow completes. Skill runs are short-lived
  // (single tool, ~1s) so a synchronous response is fine. If runtime
  // grows (e.g. once start_logger_writer is in the catalog and waits
  // for the Deployment to come ready), switch this route to return
  // `{ runId }` immediately and add a separate poll/stream endpoint.
  const result = await run.returnValue;

  return {
    workflowRunId: run.runId,
    ...result,
  };
});
