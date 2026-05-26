import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import {
  loggerTableSchema,
  type LoggerTable,
} from "@/extensions/data-architect/schema";
import { createLoggerDeliveryStream } from "@/lib/firehose";
import { log } from "@/lib/log";
import { generateAndPublishLoggerSdk } from "@/lib/logger-sdk-generator";

/**
 * Walking-skeleton workflow for the post-merge pipeline.
 *
 * Per added/modified logger_table we walk a 2-step provisioning chain:
 * create the Firehose delivery stream, then publish a typed TypeScript
 * SDK client for it. Each step writes its outcome (and any error) back to
 * the `pipelineWorkflowSteps` row so the /workflows card can render
 * progress in real time.
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
  "Create Amazon Firehose Stream",
  "Generate TypeScript SDK client",
] as const;

type StepRunner = (table: LoggerTable) => Promise<void>;

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

  for (const d of loggerTables) {
    const parsed = loggerTableSchema.safeParse(d.spec);
    if (!parsed.success) {
      // If the spec doesn't parse, fail every step in this chain with the
      // same message so the UI shows the same diagnostic on each row.
      const msg = `logger_table spec failed to parse: ${parsed.error.message}`;
      for (let i = 0; i < LOGGER_TABLE_STEPS.length; i++) {
        await markStep(input.pipelineRunId, d.id, i, "failed", msg);
      }
      continue;
    }
    const table = parsed.data;

    const runners: StepRunner[] = [
      async (t) => {
        const result = await createLoggerDeliveryStream(t.name);
        log.info("post_pipeline_pr_merge.firehose_stream", {
          pipeline_run_id: input.pipelineRunId,
          definition_id: d.id,
          table_name: t.name,
          stream_name: result.streamName,
          s3_prefix: result.s3Prefix,
          already_existed: result.alreadyExisted,
          skipped: result.skipped,
        });
      },
      async (t) => {
        const result = await generateAndPublishLoggerSdk(t);
        log.info("post_pipeline_pr_merge.sdk_client", {
          pipeline_run_id: input.pipelineRunId,
          definition_id: d.id,
          table_name: t.name,
          s3_uri: result.s3Uri,
          byte_length: result.byteLength,
        });
      },
    ];

    for (let i = 0; i < runners.length; i++) {
      await markStep(input.pipelineRunId, d.id, i, "running");
      try {
        await runners[i]!(table);
        await markStep(input.pipelineRunId, d.id, i, "succeeded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markStep(input.pipelineRunId, d.id, i, "failed", msg);
        // Don't run later steps in this chain — they depend on the earlier
        // ones (the SDK references the stream name). Other tables continue.
        break;
      }
    }
  }
}

async function markStep(
  runId: string,
  definitionId: string,
  stepOrder: number,
  status: "running" | "succeeded" | "failed",
  errorMessage?: string,
): Promise<void> {
  const now = new Date();
  const patch: {
    status: typeof status;
    startedAt?: Date;
    finishedAt?: Date;
    errorMessage?: string;
  } = { status };
  if (status === "running") patch.startedAt = now;
  if (status === "succeeded" || status === "failed") patch.finishedAt = now;
  if (errorMessage) patch.errorMessage = errorMessage;

  await getDb()
    .update(schema.pipelineWorkflowSteps)
    .set(patch)
    .where(
      and(
        eq(schema.pipelineWorkflowSteps.runId, runId),
        eq(schema.pipelineWorkflowSteps.definitionId, definitionId),
        eq(schema.pipelineWorkflowSteps.stepOrder, stepOrder),
      ),
    );
}

async function markRunSucceededStep(pipelineRunId: string): Promise<void> {
  "use step";
  await getDb()
    .update(schema.pipelineWorkflowRuns)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(schema.pipelineWorkflowRuns.id, pipelineRunId));
}
