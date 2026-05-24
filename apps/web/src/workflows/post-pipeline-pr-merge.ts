import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { log } from "@/lib/log";

/**
 * Walking-skeleton workflow for the post-merge pipeline.
 *
 * Today: one step logs the merge, then a final step flips the
 * `pipeline_workflow_run` row to `succeeded` so the /workflows page can
 * show terminal status. The webhook inserts the row before start() and
 * passes `pipelineRunId` in — WDK 4.x doesn't surface its own runId from
 * inside a workflow body, so the row key is something we control.
 *
 * Next iterations will add per-`kind` task chains (logger_table provisions
 * a Kafka topic + proto + schema-registry entry + Iceberg table + writer
 * Deployment; lattik_table reconciles DAG YAMLs; etc.). The o2flow
 * `dagRunner` topology pattern is the model.
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

export async function postPipelineMergeWorkflow(
  input: PostPipelineMergeInput,
): Promise<PostPipelineMergeResult> {
  "use workflow";
  const result = await acknowledgeMergeStep(input);
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

async function markRunSucceededStep(pipelineRunId: string): Promise<void> {
  "use step";
  await getDb()
    .update(schema.pipelineWorkflowRuns)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(schema.pipelineWorkflowRuns.id, pipelineRunId));
}
