import { describe, it, expect } from "vitest";
import type { DagOverviewIntent } from "@eloquio/render-intents";
import { dagOverviewToSpec, intentToSpec } from "../src/index.js";

const sampleIntent: DagOverviewIntent = {
  kind: "dag-overview",
  surface: "main",
  data: {
    dags: [
      {
        dagId: "lattik__user_events",
        description: "User events pipeline",
        isPaused: false,
        isActive: true,
        schedule: "@hourly",
        tags: ["lattik"],
        nextRun: "2026-05-03T00:00:00Z",
        lastRunState: "success",
        recentRunStates: ["success", "success", "failed"],
      },
      {
        dagId: "lattik__page_views",
        description: null,
        isPaused: true,
        isActive: false,
        schedule: { value: "@daily" },
        tags: ["lattik"],
        nextRun: null,
        lastRunState: null,
        recentRunStates: [],
      },
    ],
    totalEntries: 2,
  },
};

describe("dagOverviewToSpec", () => {
  it("emits a Spec with one DagCard per DAG and an OverviewHeader", () => {
    const spec = dagOverviewToSpec(sampleIntent);
    expect(spec.root).toBe("main");
    expect(spec.elements.main).toMatchObject({
      type: "Section",
      children: ["header", "dag-0", "dag-1"],
    });
    expect(spec.elements.header).toMatchObject({
      type: "OverviewHeader",
      props: { dagCount: 2, activeCount: 1, pausedCount: 1 },
    });
    expect(spec.elements["dag-0"]).toMatchObject({
      type: "DagCard",
      props: {
        dagId: "lattik__user_events",
        status: "active",
        schedule: "@hourly",
        lastRunState: "success",
        recentRuns: ["success", "success", "failed"],
      },
    });
  });

  it("flattens object-form schedules ({ value: ... }) to strings", () => {
    const spec = dagOverviewToSpec(sampleIntent);
    expect(spec.elements["dag-1"]).toMatchObject({
      props: { schedule: "@daily" },
    });
  });

  it("substitutes placeholders for missing description / runs", () => {
    const spec = dagOverviewToSpec(sampleIntent);
    expect(spec.elements["dag-1"]).toMatchObject({
      props: {
        description: "",
        status: "paused",
        lastRunState: "no runs",
        recentRuns: ["none"],
      },
    });
  });
});

describe("intentToSpec dispatcher", () => {
  it("dispatches dag-overview to the matching translator", () => {
    const spec = intentToSpec(sampleIntent);
    expect(spec.elements.main).toMatchObject({ type: "Section" });
  });

  // Every RenderIntent kind now has a real translator. The
  // PlaceholderCard fallback is kept in the source as a graceful
  // degradation hook for future kinds that ship before their adapter,
  // but there's no kind to test it against today — when the next new
  // kind lands, add a placeholder test against it for the in-flight
  // window.
});
