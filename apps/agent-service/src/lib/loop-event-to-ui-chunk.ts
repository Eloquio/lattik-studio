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
 */
export function loopEventToUIMessageChunk(): TransformStream<LoopEvent, UIMessageChunk> {
  let started = false;
  let currentIteration: number | null = null;
  let currentTextId: string | null = null;

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
      switch (event.type) {
        case "text-delta": {
          transitionToIteration(controller, event.iteration);
          if (currentTextId === null) {
            currentTextId = `t${event.iteration}`;
            controller.enqueue({ type: "text-start", id: currentTextId });
          }
          controller.enqueue({
            type: "text-delta",
            id: currentTextId,
            delta: event.payload.delta,
          });
          break;
        }
        case "model-finish": {
          transitionToIteration(controller, event.iteration);
          if (currentTextId !== null) {
            controller.enqueue({ type: "text-end", id: currentTextId });
            currentTextId = null;
          }
          // No finish-step here — tool calls may follow in the same step.
          break;
        }
        case "tool-call": {
          transitionToIteration(controller, event.iteration);
          controller.enqueue({
            type: "tool-input-start",
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
          });
          controller.enqueue({
            type: "tool-input-available",
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            input: event.payload.input,
          });
          break;
        }
        case "tool-result": {
          controller.enqueue({
            type: "tool-output-available",
            toolCallId: event.payload.toolCallId,
            output: event.payload.output,
          });
          break;
        }
        case "loop-finish": {
          if (currentTextId !== null) {
            controller.enqueue({ type: "text-end", id: currentTextId });
            currentTextId = null;
          }
          if (currentIteration !== null) {
            controller.enqueue({ type: "finish-step" });
            currentIteration = null;
          }
          controller.enqueue({ type: "finish" });
          break;
        }
      }
    },
  });
}
