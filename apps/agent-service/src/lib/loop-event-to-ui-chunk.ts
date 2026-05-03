import type { UIMessageChunk } from "ai";
import type { LoopEvent } from "../workflows/agent-loop.js";

/**
 * Translates the workflow loop's `LoopEvent` stream into the AI SDK's
 * `UIMessageChunk` wire format that `useChat` consumes.
 *
 * The transform is stateful — it tracks step boundaries (one step per
 * loop iteration), text-part lifecycle (start/delta/end per iteration's
 * text), and emits `start` / `finish` exactly once each. Tool calls are
 * surfaced as `tool-input-start` + `tool-input-available` followed by a
 * `tool-output-available` once the tool step writes its result.
 *
 * Mapping summary:
 *   text-delta(it=N)        → start? + start-step? + text-start? + text-delta
 *   model-finish(it=N)      → text-end (closes the in-progress text part)
 *   tool-call(it=N, …)      → tool-input-start + tool-input-available
 *   tool-result(toolCallId) → tool-output-available
 *   loop-finish             → text-end? + finish-step + finish
 *
 * `finish-step` is emitted at iteration boundaries (when a new
 * iteration's first event arrives) and at `loop-finish`, never inside
 * `model-finish` — model-finish doesn't end the step; tool calls may
 * still follow within the same iteration.
 *
 * `skipFirstN` is the strict-spec reattach knob. The translator state
 * machine consumes ALL events (so `started`, `currentIteration`, and
 * `currentTextId` are correctly seeded by the time we reach the
 * cursor), but suppresses output for the first N events. That lets a
 * reattaching client open a stream from index 0 conceptually, drop the
 * prefix it already saw, and receive a coherent SSE tail without any
 * duplicate `start` / `start-step` / `text-start` chunks.
 */
export function loopEventToUIMessageChunk({
  skipFirstN = 0,
}: { skipFirstN?: number } = {}): TransformStream<LoopEvent, UIMessageChunk> {
  let started = false;
  let currentIteration: number | null = null;
  let currentTextId: string | null = null;
  let position = 0;

  function transitionToIteration(
    controller: TransformStreamDefaultController<UIMessageChunk>,
    iteration: number,
  ) {
    if (currentIteration === iteration) return;
    if (currentIteration !== null) {
      if (currentTextId !== null) {
        controller.enqueue({ type: "text-end", id: currentTextId });
        currentTextId = null;
      }
      controller.enqueue({ type: "finish-step" });
    }
    if (!started) {
      controller.enqueue({ type: "start" });
      started = true;
    }
    controller.enqueue({ type: "start-step" });
    currentIteration = iteration;
    currentTextId = null;
  }

  return new TransformStream<LoopEvent, UIMessageChunk>({
    transform(event, controller) {
      // While we're still in the prefix the client already saw, run the
      // state machine but discard its output. Past the cursor, forward
      // chunks normally. Cast is harmless — only `enqueue` is read.
      const sink: TransformStreamDefaultController<UIMessageChunk> =
        position < skipFirstN
          ? ({
              enqueue: () => {},
            } as unknown as TransformStreamDefaultController<UIMessageChunk>)
          : controller;
      position++;
      switch (event.type) {
        case "text-delta": {
          transitionToIteration(sink, event.iteration);
          if (currentTextId === null) {
            currentTextId = `t${event.iteration}`;
            sink.enqueue({ type: "text-start", id: currentTextId });
          }
          sink.enqueue({
            type: "text-delta",
            id: currentTextId,
            delta: event.payload.delta,
          });
          break;
        }
        case "model-finish": {
          transitionToIteration(sink, event.iteration);
          if (currentTextId !== null) {
            sink.enqueue({ type: "text-end", id: currentTextId });
            currentTextId = null;
          }
          // No finish-step here — tool calls may follow in the same step.
          break;
        }
        case "tool-call": {
          transitionToIteration(sink, event.iteration);
          sink.enqueue({
            type: "tool-input-start",
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
          });
          sink.enqueue({
            type: "tool-input-available",
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            input: event.payload.input,
          });
          break;
        }
        case "tool-result": {
          sink.enqueue({
            type: "tool-output-available",
            toolCallId: event.payload.toolCallId,
            output: event.payload.output,
          });
          break;
        }
        case "loop-finish": {
          if (currentTextId !== null) {
            sink.enqueue({ type: "text-end", id: currentTextId });
            currentTextId = null;
          }
          if (currentIteration !== null) {
            sink.enqueue({ type: "finish-step" });
            currentIteration = null;
          }
          sink.enqueue({ type: "finish" });
          break;
        }
      }
    },
  });
}
