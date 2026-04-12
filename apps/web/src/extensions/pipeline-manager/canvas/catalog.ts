import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const catalog = defineCatalog(schema, {
  components: {
    Section: {
      props: z.object({}),
      description: "Vertical section container.",
    },
    OverviewHeader: {
      props: z.object({
        dagCount: z.number(),
        activeCount: z.number(),
        pausedCount: z.number(),
      }),
      description: "Overview header with DAG count stats.",
    },
    DagCard: {
      props: z.object({
        dagId: z.string(),
        description: z.string(),
        status: z.enum(["active", "paused", "inactive"]),
        schedule: z.string(),
        lastRunState: z.string(),
        recentRuns: z.array(
          z.enum(["success", "failed", "running", "queued", "none"])
        ),
      }),
      description: "Card for a single DAG with status badge and run history dots.",
    },
    RunDetailHeader: {
      props: z.object({
        dagId: z.string(),
        logicalDate: z.string(),
        state: z.string(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      }),
      description: "Header for a DAG run detail view.",
    },
    TaskRow: {
      props: z.object({
        taskId: z.string(),
        taskType: z.enum(["sensor", "spark", "unknown"]),
        state: z.string(),
        duration: z.string(),
        tryNumber: z.number(),
      }),
      description: "A single task instance row with status indicator.",
    },
  },
  actions: {},
});
