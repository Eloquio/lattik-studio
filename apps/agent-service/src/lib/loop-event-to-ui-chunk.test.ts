import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UIMessageChunk } from "ai";
import { loopEventToUIMessageChunk } from "./loop-event-to-ui-chunk.js";
import type { LoopEvent } from "../workflows/agent-loop.js";

/**
 * Drive the translator with a synthetic event sequence and collect the
 * UIMessageChunks it emits. Saves us spinning up a real WHATWG stream.
 *
 * Each test passes a list of events; we feed them one at a time through
 * the underlying TransformStream's transformer, capturing whatever the
 * controller's `enqueue` would have produced. The transform fn takes
 * `(chunk, controller)` per the WHATWG spec, so we synthesize a tiny
 * controller stub.
 */
function runTranslator(
  events: LoopEvent[],
  options?: { skipFirstN?: number },
): UIMessageChunk[] {
  const transform = loopEventToUIMessageChunk(options);
  // The TransformStream from the SDK has `transformer` accessible via
  // its private constructor, but we can't get at it cleanly. Pipe the
  // events through a real ReadableStream → readable → toArray for a
  // tighter reproduction of runtime behavior.
  return runTranslatorViaPipe(events, transform);
}

async function runTranslatorViaPipeAsync(
  events: LoopEvent[],
  ts: TransformStream<LoopEvent, UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const out: UIMessageChunk[] = [];
  // Push events first, then close, then drain. Avoids backpressure
  // deadlocks by reading after the write side is closed.
  const writePromise = (async () => {
    for (const e of events) await writer.write(e);
    await writer.close();
  })();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  await writePromise;
  return out;
}

// Synchronous wrapper for ergonomics — node:test handles async natively
// but the call sites read cleaner with an array return. Internally we
// still run the async pipe.
function runTranslatorViaPipe(
  events: LoopEvent[],
  ts: TransformStream<LoopEvent, UIMessageChunk>,
): UIMessageChunk[] {
  // node:test's `it(name, async fn)` makes async fine — re-export as such.
  // This shim is only here to preserve the function signature; tests
  // call the async version directly.
  void ts;
  void events;
  throw new Error("call runTranslatorAsync from inside an async test");
}

const runTranslatorAsync = async (
  events: LoopEvent[],
  options?: { skipFirstN?: number },
): Promise<UIMessageChunk[]> => {
  const ts = loopEventToUIMessageChunk(options);
  return runTranslatorViaPipeAsync(events, ts);
};

// Quiet the unused-warning by keeping `runTranslator` as an exported-for-
// tests helper. The async variant is what tests actually use.
void runTranslator;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loopEventToUIMessageChunk — single iteration with text only", () => {
  it("emits start → start-step → text-* → finish-step → finish on loop-finish", async () => {
    const out = await runTranslatorAsync([
      { type: "text-delta", iteration: 0, payload: { delta: "Hello" } },
      { type: "text-delta", iteration: 0, payload: { delta: ", world" } },
      {
        type: "model-finish",
        iteration: 0,
        payload: { text: "Hello, world", finishReason: "stop", toolCallCount: 0 },
      },
      {
        type: "loop-finish",
        iteration: 0,
        payload: {
          agentId: "PipelineManager",
          finalText: "Hello, world",
          modelStepInvocations: 1,
          toolStepInvocations: 0,
        },
      },
    ]);

    assert.deepEqual(
      out.map((c) => c.type),
      [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
      ],
    );
    // Text part keyed by iteration index — the contract reattach relies on.
    const textStart = out.find((c) => c.type === "text-start");
    assert.equal((textStart as { id: string }).id, "t0");
  });
});

describe("loopEventToUIMessageChunk — tool call iteration followed by text", () => {
  it("opens a step for the tool, closes it, opens another for the text", async () => {
    const out = await runTranslatorAsync([
      // Iteration 0: model decides to call a tool. No text deltas.
      {
        type: "model-finish",
        iteration: 0,
        payload: { text: "", finishReason: "tool-calls", toolCallCount: 1 },
      },
      {
        type: "tool-call",
        iteration: 0,
        payload: { toolCallId: "tc1", toolName: "listDags", input: {} },
      },
      {
        type: "tool-result",
        iteration: 0,
        payload: { toolCallId: "tc1", output: { dags: [] } },
      },
      // Iteration 1: model writes the answer.
      { type: "text-delta", iteration: 1, payload: { delta: "Done." } },
      {
        type: "model-finish",
        iteration: 1,
        payload: { text: "Done.", finishReason: "stop", toolCallCount: 0 },
      },
      {
        type: "loop-finish",
        iteration: 1,
        payload: {
          agentId: "PipelineManager",
          finalText: "Done.",
          modelStepInvocations: 2,
          toolStepInvocations: 1,
        },
      },
    ]);

    assert.deepEqual(
      out.map((c) => c.type),
      [
        // Iteration 0 boundary opens here on the model-finish (no text).
        "start",
        "start-step",
        // Tool-call: tool-input-start + tool-input-available
        "tool-input-start",
        "tool-input-available",
        // Tool-result
        "tool-output-available",
        // Iteration 1 boundary closes 0 + opens 1
        "finish-step",
        "start-step",
        // Iteration 1 text
        "text-start",
        "text-delta",
        "text-end",
        // Loop-finish closes everything
        "finish-step",
        "finish",
      ],
    );

    // Tool-call payload is forwarded into both the input-start +
    // input-available chunks. This is the data the chat-panel uses to
    // render the tool pill — getting it wrong was a real cutover bug.
    const inAvail = out.find((c) => c.type === "tool-input-available") as {
      toolCallId: string;
      toolName: string;
      input: unknown;
    };
    assert.equal(inAvail.toolCallId, "tc1");
    assert.equal(inAvail.toolName, "listDags");
    assert.deepEqual(inAvail.input, {});

    const outAvail = out.find((c) => c.type === "tool-output-available") as {
      toolCallId: string;
      output: unknown;
    };
    assert.equal(outAvail.toolCallId, "tc1");
    assert.deepEqual(outAvail.output, { dags: [] });
  });
});

describe("loopEventToUIMessageChunk — model-finish does NOT emit finish-step", () => {
  it("keeps the step open after model-finish in case tool calls follow", async () => {
    // The translator must NOT close the step on model-finish; tool
    // calls within the same iteration would then be orphaned outside
    // any step. Iteration boundary or loop-finish are the only valid
    // step-closers.
    const out = await runTranslatorAsync([
      {
        type: "model-finish",
        iteration: 0,
        payload: { text: "", finishReason: "tool-calls", toolCallCount: 1 },
      },
      // No tool calls actually emitted in this fixture — the contract is
      // that the close happens later, not on model-finish.
    ]);

    assert.equal(
      out.filter((c) => c.type === "finish-step").length,
      0,
      "no finish-step should appear after only a model-finish",
    );
  });
});

describe("loopEventToUIMessageChunk — strict-spec reattach prefix", () => {
  // Same event sequence as the tool-call-then-text test; we run the full
  // 12-event prefix once with no skip (canonical), then again with
  // various skipFirstN values to confirm the state machine reseeds
  // correctly and only emits the tail.
  const fullEvents: LoopEvent[] = [
    {
      type: "model-finish",
      iteration: 0,
      payload: { text: "", finishReason: "tool-calls", toolCallCount: 1 },
    },
    {
      type: "tool-call",
      iteration: 0,
      payload: { toolCallId: "tc1", toolName: "listDags", input: {} },
    },
    {
      type: "tool-result",
      iteration: 0,
      payload: { toolCallId: "tc1", output: { dags: [] } },
    },
    { type: "text-delta", iteration: 1, payload: { delta: "Done." } },
    {
      type: "model-finish",
      iteration: 1,
      payload: { text: "Done.", finishReason: "stop", toolCallCount: 0 },
    },
    {
      type: "loop-finish",
      iteration: 1,
      payload: {
        agentId: "PipelineManager",
        finalText: "Done.",
        modelStepInvocations: 2,
        toolStepInvocations: 1,
      },
    },
  ];

  it("with skipFirstN=0 emits the canonical full sequence", async () => {
    const out = await runTranslatorAsync(fullEvents, { skipFirstN: 0 });
    // Sanity: exactly one `start` chunk.
    assert.equal(out.filter((c) => c.type === "start").length, 1);
    // Two start-steps: one per iteration.
    assert.equal(out.filter((c) => c.type === "start-step").length, 2);
  });

  it("skips events before the cursor but reseeds state correctly", async () => {
    // Cursor at index 3 (just before the iteration-1 text-delta). The
    // state machine has already passed `started` and `currentIteration=0`
    // so it should NOT emit `start` again. It should still emit the
    // iteration boundary because that transition happens AT the cursor.
    const out = await runTranslatorAsync(fullEvents, { skipFirstN: 3 });

    // No spurious start chunk.
    assert.equal(
      out.filter((c) => c.type === "start").length,
      0,
      "reattach must not duplicate `start`",
    );
    // The iteration boundary at the cursor still produces finish-step +
    // start-step for the new iteration.
    assert.equal(out.filter((c) => c.type === "start-step").length, 1);
    // Text part of iteration 1 surfaces normally.
    assert.equal(out.filter((c) => c.type === "text-delta").length, 1);
    // Loop-finish still emits one `finish` (not duplicated).
    assert.equal(out.filter((c) => c.type === "finish").length, 1);
  });

  it("with skipFirstN past the end emits only the loop-finish closers", async () => {
    // Cursor past every event but loop-finish. By the time the cursor
    // is reached, the iteration-1 model-finish (event 4 in the
    // fixture) has already closed the text-end for that iteration —
    // so loop-finish only needs to emit `finish-step` for the still-
    // open iteration plus the terminating `finish`. No `text-end`
    // here because there's no in-progress text part anymore.
    const out = await runTranslatorAsync(fullEvents, {
      skipFirstN: fullEvents.length - 1,
    });
    assert.deepEqual(
      out.map((c) => c.type),
      ["finish-step", "finish"],
    );
  });
});

describe("loopEventToUIMessageChunk — loop-finish closes hanging text + step", () => {
  it("emits text-end if there's an open text-part when loop-finish arrives", async () => {
    // Pathological: model-finish missing for some reason (shouldn't
    // happen in practice but the translator should still close cleanly).
    const out = await runTranslatorAsync([
      { type: "text-delta", iteration: 0, payload: { delta: "Hi" } },
      {
        type: "loop-finish",
        iteration: 0,
        payload: {
          agentId: "PipelineManager",
          finalText: "Hi",
          modelStepInvocations: 1,
          toolStepInvocations: 0,
        },
      },
    ]);

    assert.deepEqual(
      out.map((c) => c.type),
      ["start", "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish"],
    );
  });
});
