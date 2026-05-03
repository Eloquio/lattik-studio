import { defineEventHandler, readValidatedBody, createError } from "h3";
import { z } from "zod";

/**
 * /chat — Phase 1 placeholder.
 *
 * The route accepts the chat protocol's request shape, validates auth via
 * the global middleware, and echoes back enough structure to confirm the
 * pipeline is wired. Actual agent execution (Vercel Workflow + DurableAgent)
 * + SSE streaming lands in the next slice. Treating this as a documented
 * stub so the auth + protocol contract can be exercised before the runtime
 * shows up.
 */

const chatRequestSchema = z.object({
  /** Stable conversation id; scopes a thread for the calling client. */
  conversationId: z.string().min(1),
  /** Specialist agent the user wants to talk to (matches an AGENT.md `id`). */
  agentId: z.string().min(1),
  /** New user message to append. */
  message: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const auth = event.context.auth;
  if (!auth) {
    throw createError({
      statusCode: 500,
      statusMessage: "auth context missing — middleware not wired",
    });
  }
  const body = await readValidatedBody(event, (data) =>
    chatRequestSchema.safeParse(data),
  );
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid chat request: ${body.error.message}`,
    });
  }
  return {
    status: "stub",
    received: {
      clientId: auth.clientId,
      userId: auth.userId,
      conversationId: body.data.conversationId,
      agentId: body.data.agentId,
      message: body.data.message,
    },
    note: "Real agent execution + SSE streaming lands in the next slice (Vercel Workflow + DurableAgent).",
  };
});
