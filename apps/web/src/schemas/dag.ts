import { z } from "zod";

/**
 * YAML DAG definition schema.
 *
 * Source files live in the sibling `lattik-pipelines` repo under `dags/`.
 * Each YAML names tasks whose `fn` is a function exported from the
 * `tasks/` bundle that gets uploaded alongside the DAGs by the
 * lattik-pipelines GitHub Action.
 *
 * This is a stripped-down version of o2flow's DAG schema: no template
 * machinery, no per-task `access:` capabilities, no `owners`. Add those
 * back when the corresponding features (templates, fine-grained access)
 * are wanted — none of them are required for core scheduling.
 */

const cronExpression = z.string().min(1).describe("5-field cron expression");

const durationString = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/i)
  .describe('Duration string like "30s", "5m", "2h", "1d"');

const ianaTimezone = z
  .string()
  .min(1)
  .describe("IANA timezone, e.g. America/Los_Angeles");

const slugId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i)
  .describe("Lowercase slug; letters, digits, dash, underscore");

const INLINE_TIMEZONE_DEFAULT = "UTC";
const INLINE_CATCHUP_DEFAULT = true;
const INLINE_MAX_ACTIVE_RUNS_DEFAULT = 3;
const INLINE_TIMEOUT_DEFAULT = "30m";

export const taskDefSchema = z.object({
  id: slugId,
  fn: z.string().min(1).describe("Named export from the bundle to invoke"),
  dependsOn: z.array(slugId).optional(),
  timeout: durationString.optional(),
  /** Per-task parameters threaded through to the runtime ctx as-is. */
  args: z.record(z.string(), z.unknown()).optional(),
});

export const dagDefSchema = z.object({
  id: slugId,
  description: z.string().optional(),
  schedule: cronExpression,
  timezone: ianaTimezone.default(INLINE_TIMEZONE_DEFAULT),
  startDate: z.iso.date().or(z.iso.datetime()),
  catchup: z.boolean().default(INLINE_CATCHUP_DEFAULT),
  maxActiveRuns: z
    .int()
    .min(1)
    .max(100)
    .default(INLINE_MAX_ACTIVE_RUNS_DEFAULT),
  defaults: z
    .object({
      timeout: durationString.default(INLINE_TIMEOUT_DEFAULT),
    })
    .default({ timeout: INLINE_TIMEOUT_DEFAULT }),
  tasks: z.array(taskDefSchema).min(1),
});

export type DagDef = z.infer<typeof dagDefSchema>;
export type TaskDef = z.infer<typeof taskDefSchema>;
