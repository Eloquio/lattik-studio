import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rollUpRunStatus, type RollupStep } from "./post-pipeline-pr-merge";

function step(over: Partial<RollupStep>): RollupStep {
  return {
    definitionId: "def-1",
    definitionName: "events.evt_conversation",
    stepOrder: 0,
    status: "succeeded",
    ...over,
  };
}

describe("rollUpRunStatus", () => {
  it("is succeeded for a run with no steps", () => {
    // A PR that touched no logger_tables has no step rows — clean success.
    assert.strictEqual(rollUpRunStatus([]), "succeeded");
  });

  it("is succeeded when every step succeeded", () => {
    const steps = [
      step({ stepOrder: 0 }),
      step({ stepOrder: 1 }),
    ];
    assert.strictEqual(rollUpRunStatus(steps), "succeeded");
  });

  it("is failed when any step failed — the bug this fixes", () => {
    // Before the rollup, the finalizer wrote "succeeded" unconditionally and
    // this run rendered a green badge over a red step.
    const steps = [
      step({ stepOrder: 0, status: "succeeded" }),
      step({ stepOrder: 1, status: "failed" }),
    ];
    assert.strictEqual(rollUpRunStatus(steps), "failed");
  });

  it("treats a failed-then-succeeded retry of the same step as success", () => {
    // Webhook redelivery / retry leaves two rows for the same
    // (definition, stepOrder); succeeded outranks failed, so it isn't
    // counted as a failure.
    const steps = [
      step({ stepOrder: 0, status: "failed" }),
      step({ stepOrder: 0, status: "succeeded" }),
    ];
    assert.strictEqual(rollUpRunStatus(steps), "succeeded");
  });

  it("still fails when a duplicated step never succeeded", () => {
    const steps = [
      step({ stepOrder: 0, status: "running" }),
      step({ stepOrder: 0, status: "failed" }),
    ];
    assert.strictEqual(rollUpRunStatus(steps), "failed");
  });

  it("does not let a sibling chain's success mask another chain's failure", () => {
    // Two distinct definitions sharing stepOrder 0. Keying only on
    // (definitionId, stepOrder) would collapse them; the failure must
    // survive. This is why the dedup key includes definitionName and
    // definitionId both.
    const steps = [
      step({ definitionId: "def-a", definitionName: "tbl.a", status: "failed" }),
      step({ definitionId: "def-b", definitionName: "tbl.b", status: "succeeded" }),
    ];
    assert.strictEqual(rollUpRunStatus(steps), "failed");
  });

  it("keeps null-definitionId chains distinct by definitionName", () => {
    // definitionId is nullable in the schema. Two chains with null ids but
    // different names at the same stepOrder must not collapse, or a failure
    // could be masked by a sibling success.
    const steps = [
      step({ definitionId: null, definitionName: "tbl.a", status: "failed" }),
      step({ definitionId: null, definitionName: "tbl.b", status: "succeeded" }),
    ];
    assert.strictEqual(rollUpRunStatus(steps), "failed");
  });

  it("counts a chain whose first step failed and rest skipped as failed", () => {
    // Mirrors runLoggerTableStepsStep: on failure, later steps are marked
    // "skipped" rather than left pending.
    const steps = [
      step({ stepOrder: 0, status: "failed" }),
      step({ stepOrder: 1, status: "skipped" }),
    ];
    assert.strictEqual(rollUpRunStatus(steps), "failed");
  });
});
