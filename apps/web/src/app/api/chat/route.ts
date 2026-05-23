import { z } from "zod";
import {
  JsonToSseTransformStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { start } from "workflow/api";
import { auth } from "@/auth";
import {
  agentLoopWorkflow,
  type AgentId,
} from "@/workflows/agent-loop";
import { loopEventToUIMessageChunk } from "@/lib/agent/loop-event-to-ui-chunk";
import { recordRunOwner } from "@/lib/agent/workflow-runs";

const agentIdSchema = z.enum([
  "Assistant",
  "PipelineManager",
  "DataArchitect",
  "DataAnalyst",
]);

const taskStackEntrySchema = z.object({
  extensionId: z.string(),
  reason: z.string(),
});

const bodySchema = z.object({
  agentId: agentIdSchema,
  conversationId: z.string().min(1),
  newUserMessages: z.array(z.unknown()).default([]),
  canvasState: z.unknown().optional(),
  taskStack: z.array(taskStackEntrySchema).default([]),
  regenerateFromMessageId: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: `Invalid body: ${parsed.error.message}` },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const run = await start(agentLoopWorkflow, [
    {
      agentId: body.agentId as AgentId,
      conversationId: body.conversationId,
      newUserMessages: body.newUserMessages as UIMessage[],
      canvasState: body.canvasState ?? null,
      userId,
      taskStack: body.taskStack,
      regenerateFromMessageId: body.regenerateFromMessageId,
    },
  ]);
  await recordRunOwner({
    runId: run.runId,
    userId,
    conversationId: body.conversationId,
  });

  const stream = run.readable
    .pipeThrough(loopEventToUIMessageChunk())
    .pipeThrough(
      new JsonToSseTransformStream() as unknown as TransformStream<
        UIMessageChunk,
        string
      >,
    )
    .pipeThrough(new TextEncoderStream());

  return new Response(stream, {
    headers: {
      "x-run-id": run.runId,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
