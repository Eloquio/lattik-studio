import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  ]
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const conversations = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    messages: jsonb("messages").notNull().$type<unknown[]>().default([]),
    canvasState: jsonb("canvasState").$type<unknown>(),
    taskStack: jsonb("taskStack").$type<unknown[]>(),
    activeExtensionId: text("activeExtensionId"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_conversations_userId").on(t.userId)]
);

export type DefinitionKind =
  | "entity"
  | "dimension"
  | "logger_table"
  | "lattik_table"
  | "metric";

export type DefinitionStatus =
  | "draft"
  | "pending_review"
  | "merged"
  | "pending_deletion"
  | "invalid";

export const definitions = pgTable(
  "definition",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: text("kind").$type<DefinitionKind>().notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    spec: jsonb("spec").notNull().$type<unknown>(),
    status: text("status").$type<DefinitionStatus>().notNull().default("draft"),
    prUrl: text("prUrl"),
    prMergedAt: timestamp("prMergedAt", { mode: "date" }),
    createdBy: text("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_definitions_kind_name").on(t.kind, t.name),
    // `listMergedDefinitions(kind)` and the merged-status branch of
    // `listDefinitions(kind)` both filter on (kind, status). The composite
    // serves those queries; the standalone (kind) and (status) indexes act
    // as prefixes/fallbacks for queries that hit only one column.
    index("idx_definitions_kind_status").on(t.kind, t.status),
    // `listDefinitions(kind)` for the owner branch and `getDefinitionByName`
    // both filter on (kind, createdBy).
    index("idx_definitions_kind_createdBy").on(t.kind, t.createdBy),
    index("idx_definitions_status").on(t.status),
    index("idx_definitions_prUrl").on(t.prUrl),
    index("idx_definitions_createdBy").on(t.createdBy),
  ]
);

/**
 * Rate-limit buckets keyed by `${scope}:${subject}` (e.g. `chat:${userId}`).
 * Stores a sliding-window counter persisted across server restarts and across
 * serverless instances. The counter resets when `resetAt` has passed.
 */
export const rateLimits = pgTable(
  "rate_limit",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    resetAt: timestamp("resetAt", { mode: "date" }).notNull(),
  },
  (t) => [index("idx_rate_limits_resetAt").on(t.resetAt)]
);

export type WebhookActionType =
  | "definition_added"
  | "definition_modified"
  | "definition_deleted"
  | "validation_failed"
  | "kafka_topic_created"
  | "schema_registered"
  | "dag_generated";

export type WebhookActionStatus = "success" | "failure";

/**
 * Audit log for webhook-triggered side effects (topic creation, DAG
 * generation, etc.). Each row records one action taken in response to
 * a webhook event, with enough context to trace what happened and why.
 */
export const webhookAuditLog = pgTable(
  "webhook_audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** The Gitea PR URL that triggered this action. */
    prUrl: text("prUrl").notNull(),
    /** The definition this action relates to (null for non-definition actions). */
    definitionId: text("definitionId").references(() => definitions.id, {
      onDelete: "set null",
    }),
    /** What kind of action was performed. */
    action: text("action").$type<WebhookActionType>().notNull(),
    /** Whether the action succeeded or failed. */
    status: text("status").$type<WebhookActionStatus>().notNull(),
    /** Error message on failure, or additional context on success. */
    detail: text("detail"),
    /** When the webhook was received. */
    receivedAt: timestamp("receivedAt", { mode: "date" }).notNull(),
    /** When the action completed (success or failure). */
    completedAt: timestamp("completedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_webhook_audit_prUrl").on(t.prUrl),
    index("idx_webhook_audit_definitionId").on(t.definitionId),
    index("idx_webhook_audit_action").on(t.action),
  ]
);

// ---------------------------------------------------------------------------
// Lattik Table stitch — commit log + per-column ETL time tracking
// ---------------------------------------------------------------------------

/**
 * Append-only commit log for Lattik Table manifests.
 * Each row records one committed manifest version. The latest row per table
 * is the current state. Time travel by wall clock uses `committed_at`.
 * Rollback = insert a new row pointing to an old manifest.
 */
export const lattikTableCommits = pgTable(
  "lattik_table_commit",
  {
    tableName: text("table_name").notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    manifestLoadId: text("manifest_load_id").notNull(),
    committedAt: timestamp("committed_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tableName, t.manifestVersion] }),
    index("idx_lattik_commits_wall_time").on(t.tableName, t.committedAt),
  ]
);

/**
 * Per-column ETL time tracking for Lattik Tables.
 * Each row says "column X for ds=Y (hour=Z) was produced by load W."
 * Used for ETL time travel (AS OF DS) and backfill idempotency.
 * Backfills use ON CONFLICT DO UPDATE to overwrite the previous entry.
 */
export const lattikColumnLoads = pgTable(
  "lattik_column_load",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    ds: date("ds", { mode: "string" }).notNull(),
    // Nullable: null means daily cadence (no hour). Unique constraint below
    // uses `nullsNotDistinct` so null counts as a real value for uniqueness.
    hour: integer("hour"),
    loadId: text("load_id").notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    committedAt: timestamp("committed_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_lattik_column_load")
      .on(t.tableName, t.columnName, t.ds, t.hour)
      .nullsNotDistinct(),
    index("idx_lattik_column_loads_ds").on(t.tableName, t.ds, t.hour),
  ]
);

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
  ]
);

/**
 * `workflow_run` — owner mapping for Vercel Workflow runs spawned by
 * agent-service. Written at start time so reattach GETs (which take a
 * runId in the URL) can verify the calling user owns the run before
 * streaming its events back. The runId itself is unguessable, but
 * verifying ownership on every read closes the defense-in-depth gap
 * the auth-wiring slice flagged.
 *
 * conversationId is optional — most runs come from chat turns and
 * carry it, but system-triggered skill runs (webhook fan-out, etc.) may not.
 */
export const workflowRuns = pgTable(
  "workflow_run",
  {
    runId: text("runId").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversationId"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_workflow_runs_userId").on(t.userId)]
);

export type PipelineWorkflowStatus = "running" | "succeeded" | "failed";

export type PipelineWorkflowStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * Append-only run log for system-triggered (non-chat) workflows like the
 * post-merge pipeline. Distinct from `workflow_run` above, which is the
 * per-user auth registry for chat reattach. WDK doesn't expose a list-runs
 * API, so we mirror runs here on start() and update on terminal so the
 * /workflows page has something to render.
 *
 * `id` is locally generated by the trigger (e.g. the webhook handler) and
 * passed into the workflow as part of its input — that lets the workflow's
 * terminal step UPDATE its own row without needing access to WDK's
 * server-assigned runId (which isn't available from inside the workflow
 * body in WDK 4.x).
 */
export const pipelineWorkflowRuns = pgTable(
  "pipeline_workflow_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Workflow function name, e.g. "post-pipeline-pr-merge". */
    workflowName: text("workflowName").notNull(),
    status: text("status").$type<PipelineWorkflowStatus>().notNull(),
    /** Optional context for the listing UI — the PR URL that triggered it. */
    prUrl: text("prUrl"),
    /** Small snapshot of the workflow input so the row is self-describing. */
    input: jsonb("input"),
    startedAt: timestamp("startedAt", { mode: "date" }).notNull().defaultNow(),
    finishedAt: timestamp("finishedAt", { mode: "date" }),
    errorMessage: text("errorMessage"),
  },
  (t) => [
    index("idx_pipeline_workflow_runs_startedAt").on(t.startedAt),
    index("idx_pipeline_workflow_runs_status").on(t.status),
  ]
);

/**
 * Sub-steps of a `pipelineWorkflowRuns` row. Each new/modified
 * logger_table (and, later, other kinds) gets its own per-definition
 * provisioning chain — e.g. for a logger_table:
 *   1. Create Amazon Firehose Stream
 *   2. Generate TypeScript SDK client
 *
 * Steps are seeded up front (status="pending") when the workflow starts
 * so the /workflows card can render the full checklist before any step
 * has run, then each step transitions through "running" → "succeeded"
 * (or "failed"). One run can carry many step chains — group by
 * `definitionId` in the UI.
 */
export const pipelineWorkflowSteps = pgTable(
  "pipeline_workflow_step",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("runId")
      .notNull()
      .references(() => pipelineWorkflowRuns.id, { onDelete: "cascade" }),
    /** The definition this step chain belongs to (e.g. a logger_table). */
    definitionId: text("definitionId"),
    /** Kind of the definition, e.g. "logger_table". */
    definitionKind: text("definitionKind").notNull(),
    /** Display name of the definition, e.g. "events.evt_conversation". */
    definitionName: text("definitionName").notNull(),
    /** Short label shown in the checklist row, e.g. "Create Amazon Firehose Stream". */
    stepName: text("stepName").notNull(),
    /** Display order within this (run, definition) chain, 0-based. */
    stepOrder: integer("stepOrder").notNull(),
    status: text("status").$type<PipelineWorkflowStepStatus>().notNull(),
    startedAt: timestamp("startedAt", { mode: "date" }),
    finishedAt: timestamp("finishedAt", { mode: "date" }),
    errorMessage: text("errorMessage"),
  },
  (t) => [
    index("idx_pipeline_workflow_steps_runId").on(t.runId),
    index("idx_pipeline_workflow_steps_definitionId").on(t.definitionId),
  ]
);

// ---------------------------------------------------------------------------
// Batch scheduler — DAGs synced from the lattik-pipelines sibling repo,
// queued/dispatched by /api/scheduler/tick, executed in Vercel Sandboxes
// from a bundle produced by lattik-pipelines' GitHub Actions.
// ---------------------------------------------------------------------------

/**
 * One row per (DAG id, branch). "Branch" is "prod" for main, "pr-<n>" for an
 * open PR. The PR variants get their dag id suffixed with `_pr_<n>` so they
 * coexist in the same table. Reconciler upserts on the `(id, branch)` unique
 * constraint and soft-archives by setting `archivedAt`.
 */
export const dags = pgTable(
  "dag",
  {
    id: text("id").notNull(),
    branch: text("branch").notNull(),
    /** YAML path inside the bundle (e.g. `dags/daily_metrics.yaml`). */
    sourcePath: text("source_path").notNull(),
    yamlRaw: text("yaml_raw").notNull(),
    /** sha256(yamlRaw) — manifest cache key, also pinned onto dag_runs. */
    yamlHash: text("yaml_hash").notNull(),
    /** Zod-validated `DagDef`. */
    parsed: jsonb("parsed").notNull(),
    schedule: text("schedule").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    startDate: date("start_date").notNull(),
    catchup: boolean("catchup").notNull().default(true),
    maxActiveRuns: integer("max_active_runs").notNull().default(3),
    /** Human-toggled. Reconciler never sets this. */
    enabled: boolean("enabled").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Bookmark used by catchup — most recent enqueued logical datetime. */
    lastEnqueuedLogicalDatetime: timestamp(
      "last_enqueued_logical_datetime",
      { withTimezone: true }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("dags_id_branch_unique").on(t.id, t.branch)]
);

/**
 * One row per scheduled run. `id` is the deterministic
 * `${dagId}__${compactIso}` (e.g. `daily_metrics__20260510T000000000Z`) —
 * used both as the workflow runId argument and the URL path segment.
 *
 * `manifestSha` pins the run to the YAML version it was enqueued against.
 * The task launch step recomputes sha256(dags.yamlRaw) and refuses to launch
 * on mismatch so a YAML PR merging mid-run can't surprise the topology.
 */
export const dagRuns = pgTable(
  "dag_run",
  {
    id: text("id").primaryKey(),
    dagId: text("dag_id").notNull(),
    branch: text("branch").notNull(),
    logicalDatetime: timestamp("logical_datetime", {
      withTimezone: true,
    }).notNull(),
    /** queued | running | succeeded | failed | cancelled */
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    bundleSha: text("bundle_sha"),
    manifestSha: text("manifest_sha"),
    workflowRunId: text("workflow_run_id"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("dag_runs_dag_branch_logical_unique").on(
      t.dagId,
      t.branch,
      t.logicalDatetime
    ),
    index("idx_dag_runs_status").on(t.status),
  ]
);

/**
 * One row per (run × task × attempt). `attempt` is 1-indexed; retries are
 * not yet wired so every row today has `attempt=1`. Keeping the column
 * makes adding retries later a non-event.
 *
 * `logUrl` and `logToken` are split at rest so a generic "log_url" audit
 * dump doesn't leak the per-attempt secret. The browser-facing URL is
 * composed at serialization time as `${logUrl}?t=${logToken}`.
 */
export const taskAttempts = pgTable(
  "task_attempt",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    dagRunId: text("dag_run_id").notNull(),
    taskId: text("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    /** queued | running | succeeded | failed | skipped */
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    sandboxId: text("sandbox_id"),
    logUrl: text("log_url"),
    logToken: text("log_token"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("task_attempts_run_task_attempt_unique").on(
      t.dagRunId,
      t.taskId,
      t.attempt
    ),
  ]
);

export type Dag = typeof dags.$inferSelect;
export type DagInsert = typeof dags.$inferInsert;
export type DagRun = typeof dagRuns.$inferSelect;
export type DagRunInsert = typeof dagRuns.$inferInsert;
export type TaskAttempt = typeof taskAttempts.$inferSelect;
export type TaskAttemptInsert = typeof taskAttempts.$inferInsert;
