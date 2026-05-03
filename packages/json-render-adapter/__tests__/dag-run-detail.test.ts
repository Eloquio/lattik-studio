import { describe, it, expect } from "vitest";
import type { DagRunDetailIntent } from "@eloquio/render-intents";
import { dagRunDetailToSpec, intentToSpec } from "../src/index.js";

const sampleIntent: DagRunDetailIntent = {
  kind: "dag-run-detail",
  surface: "detail",
  data: {
    dagId: "lattik__user_events",
    runId: "manual__2026-05-02T18:00:00",
    logicalDate: "2026-05-02T18:00:00",
    runState: "failed",
    startDate: "2026-05-02T18:00:01Z",
    endDate: "2026-05-02T18:01:33Z",
    tasks: [
      {
        taskId: "wait__source_data",
        state: "success",
        operator: "DataReadySensor",
        startDate: "2026-05-02T18:00:01Z",
        endDate: "2026-05-02T18:00:30Z",
        durationSeconds: 29,
        tryNumber: 1,
        maxTries: 3,
      },
      {
        taskId: "build__user_events",
        state: "failed",
        operator: "SparkKubernetesOperator",
        startDate: "2026-05-02T18:00:31Z",
        endDate: "2026-05-02T18:01:33Z",
        durationSeconds: 62,
        tryNumber: 2,
        maxTries: 3,
      },
    ],
  },
};

describe("dagRunDetailToSpec", () => {
  it("emits a Spec with one TaskRow per task and a RunDetailHeader", () => {
    const spec = dagRunDetailToSpec(sampleIntent);
    expect(spec.root).toBe("main");
    expect(spec.elements.main).toMatchObject({
      type: "Section",
      children: ["header", "task-0", "task-1"],
    });
    expect(spec.elements.header).toMatchObject({
      type: "RunDetailHeader",
      props: {
        dagId: "lattik__user_events",
        logicalDate: "2026-05-02T18:00:00",
        state: "failed",
      },
    });
  });

  it("infers task type from taskId prefix", () => {
    const spec = dagRunDetailToSpec(sampleIntent);
    expect(spec.elements["task-0"]).toMatchObject({
      props: { taskType: "sensor" },
    });
    expect(spec.elements["task-1"]).toMatchObject({
      props: { taskType: "spark" },
    });
  });

  it("formats durations as compact human strings", () => {
    const spec = dagRunDetailToSpec(sampleIntent);
    expect((spec.elements["task-0"] as { props: { duration: string } }).props.duration).toBe("29s");
    expect((spec.elements["task-1"] as { props: { duration: string } }).props.duration).toBe("1m 2s");
  });

  it("substitutes 'unknown' for missing run state / logical date", () => {
    const spec = dagRunDetailToSpec({
      ...sampleIntent,
      data: {
        ...sampleIntent.data,
        runState: null,
        logicalDate: null,
      },
    });
    expect(spec.elements.header).toMatchObject({
      props: { state: "unknown", logicalDate: "unknown" },
    });
  });
});

describe("intentToSpec dispatches dag-run-detail", () => {
  it("routes to dagRunDetailToSpec", () => {
    const spec = intentToSpec(sampleIntent);
    expect(spec.elements.main).toMatchObject({ type: "Section" });
    expect(spec.elements.header).toMatchObject({ type: "RunDetailHeader" });
  });
});
