import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { log } from "@/lib/log";

/**
 * Walking-skeleton workflow for the post-merge pipeline.
 *
 * Today: per added/modified logger_table, we seed a checklist of
 * provisioning steps (proto descriptor, schema registry, Kafka topic,
 * Iceberg sink) and walk through them — currently as no-ops that just
 * record state so the /workflows card can render a checked status line
 * per step. Real side-effects land step-by-step in follow-ups.
 *
 * The webhook handler inserts the run row before start() and passes
 * `pipelineRunId` in — WDK 4.x doesn't surface its own runId from inside
 * a workflow body, so the row key is something we control.
 */

export interface MergedDefinitionRef {
  id: string;
  kind: string;
  name: string;
  spec: unknown;
}

export interface PostPipelineMergeInput {
  pipelineRunId: string;
  prUrl: string;
  ghDeliveryId: string;
  definitions: MergedDefinitionRef[];
}

export interface PostPipelineMergeResult {
  ok: true;
  ackedAt: string;
  definitionCount: number;
}

/**
 * Ordered checklist for provisioning a logger_table. The labels here are
 * what the user sees on the workflow card. Keep them short.
 */
const LOGGER_TABLE_STEPS = [
  "Generate Protobuf descriptor",
  "Register schema with Schema Registry",
  "Create Kafka topic",
  "Create Iceberg sink table",
] as const;

export async function postPipelineMergeWorkflow(
  input: PostPipelineMergeInput,
): Promise<PostPipelineMergeResult> {
  "use workflow";
  const result = await acknowledgeMergeStep(input);
  await seedLoggerTableStepsStep(input);
  await runLoggerTableStepsStep(input);
  await markRunSucceededStep(input.pipelineRunId);
  return result;
}

async function acknowledgeMergeStep(
  input: PostPipelineMergeInput,
): Promise<PostPipelineMergeResult> {
  "use step";
  log.info("post_pipeline_pr_merge.acknowledged", {
    pipeline_run_id: input.pipelineRunId,
    pr_url: input.prUrl,
    gh_delivery_id: input.ghDeliveryId,
    definition_count: input.definitions.length,
    kinds: input.definitions.map((d) => d.kind),
    definition_ids: input.definitions.map((d) => d.id),
  });
  return {
    ok: true,
    ackedAt: new Date().toISOString(),
    definitionCount: input.definitions.length,
  };
}

async function seedLoggerTableStepsStep(
  input: PostPipelineMergeInput,
): Promise<void> {
  "use step";
  const loggerTables = input.definitions.filter(
    (d) => d.kind === "logger_table",
  );
  if (loggerTables.length === 0) return;

  const rows = loggerTables.flatMap((d) =>
    LOGGER_TABLE_STEPS.map((stepName, i) => ({
      runId: input.pipelineRunId,
      definitionId: d.id,
      definitionKind: d.kind,
      definitionName: d.name,
      stepName,
      stepOrder: i,
      status: "pending" as const,
    })),
  );
  await getDb().insert(schema.pipelineWorkflowSteps).values(rows);
}

async function runLoggerTableStepsStep(
  input: PostPipelineMergeInput,
): Promise<void> {
  "use step";
  const loggerTables = input.definitions.filter(
    (d) => d.kind === "logger_table",
  );
  const db = getDb();
  for (const d of loggerTables) {
    for (let i = 0; i < LOGGER_TABLE_STEPS.length; i++) {
      const now = new Date();
      await db
        .update(schema.pipelineWorkflowSteps)
        .set({ status: "succeeded", startedAt: now, finishedAt: now })
        .where(
          and(
            eq(schema.pipelineWorkflowSteps.runId, input.pipelineRunId),
            eq(schema.pipelineWorkflowSteps.definitionId, d.id),
            eq(schema.pipelineWorkflowSteps.stepOrder, i),
          ),
        );
    }
  }
}

async function markRunSucceededStep(pipelineRunId: string): Promise<void> {
  "use step";
  await getDb()
    .update(schema.pipelineWorkflowRuns)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(schema.pipelineWorkflowRuns.id, pipelineRunId));
}
