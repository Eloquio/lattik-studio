import { JsonToSseTransformStream, type UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import { auth } from "@/auth";
import type { LoopEvent } from "@/workflows/agent-loop";
import { loopEventToUIMessageChunk } from "@/lib/agent/loop-event-to-ui-chunk";
import {
  assertRunOwner,
  RunNotFoundError,
} from "@/lib/agent/workflow-runs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await ctx.params;
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  try {
    await assertRunOwner({ runId, userId });
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }
    throw err;
  }

  const url = new URL(req.url);
  const startIndexRaw = url.searchParams.get("startIndex");
  const requestedStartIndex =
    startIndexRaw !== null ? Number.parseInt(startIndexRaw, 10) : undefined;

  const run = getRun<unknown>(runId);
  const tailIndex = await run.getReadable<LoopEvent>({}).getTailIndex();
  const absoluteStartIndex =
    requestedStartIndex === undefined || !Number.isFinite(requestedStartIndex)
      ? 0
      : requestedStartIndex < 0
        ? Math.max(0, tailIndex + 1 + requestedStartIndex)
        : Math.min(requestedStartIndex, tailIndex + 1);

  const readable = run.getReadable<LoopEvent>({ startIndex: 0 });

  const stream = readable
    .pipeThrough(loopEventToUIMessageChunk({ skipFirstN: absoluteStartIndex }))
    .pipeThrough(
      new JsonToSseTransformStream() as unknown as TransformStream<
        UIMessageChunk,
        string
      >,
    )
    .pipeThrough(new TextEncoderStream());

  return new Response(stream, {
    headers: {
      "x-run-id": runId,
      "x-tail-index": String(tailIndex),
      "x-resolved-start-index": String(absoluteStartIndex),
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
