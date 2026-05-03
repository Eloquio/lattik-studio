import type { Spec } from "@json-render/core";
import type { DagOverviewIntent, DagSummary } from "@eloquio/render-intents";

/**
 * Project a DagOverviewIntent into a json-render Spec the existing
 * Pipeline Manager canvas registry already understands. Element types
 * (`Section`, `OverviewHeader`, `DagCard`) are the same shapes the
 * apps/web canvas registry registers — we're just translating from the
 * typed render-intent vocabulary to the json-render Spec the registry
 * eats.
 */
export function dagOverviewToSpec(intent: DagOverviewIntent): Spec {
  const { dags } = intent.data;

  const activeCount = dags.filter((d) => !d.isPaused && d.isActive).length;
  const pausedCount = dags.filter((d) => d.isPaused).length;
  const dagCardKeys = dags.map((_, i) => `dag-${i}`);

  const elements: Record<string, unknown> = {
    main: {
      type: "Section",
      props: {},
      children: ["header", ...dagCardKeys],
    },
    header: {
      type: "OverviewHeader",
      props: {
        dagCount: dags.length,
        activeCount,
        pausedCount,
      },
    },
  };

  for (let i = 0; i < dags.length; i++) {
    const d = dags[i]!;
    elements[`dag-${i}`] = {
      type: "DagCard",
      props: dagCardProps(d),
    };
  }

  return {
    root: "main",
    elements,
    state: { selectedDagId: null },
  } as Spec;
}

function dagCardProps(d: DagSummary): Record<string, unknown> {
  return {
    dagId: d.dagId,
    description: d.description ?? "",
    status: d.isPaused ? "paused" : d.isActive ? "active" : "inactive",
    schedule: formatSchedule(d.schedule),
    lastRunState: d.lastRunState ?? "no runs",
    recentRuns: d.recentRunStates.length > 0 ? d.recentRunStates : ["none"],
  };
}

function formatSchedule(schedule: DagSummary["schedule"]): string {
  if (schedule === null) return "none";
  if (typeof schedule === "string") return schedule;
  return schedule.value;
}
