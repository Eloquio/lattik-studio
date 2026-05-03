import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
  | "pending_deletion";

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
    createdBy: text("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_definitions_kind_name").on(t.kind, t.name),
    index("idx_definitions_kind").on(t.kind),
    index("idx_definitions_status").on(t.status),
    index("idx_definitions_prUrl").on(t.prUrl),
    index("idx_definitions_createdBy").on(t.createdBy),
  ]
);

/**
 * Workers are fungible processes that execute tasks. Each task carries a
 * `skill_id`; the worker loads that skill (instructions + tool grants) and
 * follows it. Each worker has its own bearer secret so a compromised process
 * can be revoked without disturbing the fleet, and ownership of in-flight
 * claims is tracked via `task.claimed_by`.
 *
 * Auth: workers present `Authorization: Bearer <workerId>:<secret>`; the
 * server looks up the row and compares sha256(secret) to `tokenHash`.
 */
export type WorkerMode = "cluster" | "host";

export const workers = pgTable(
  "worker",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    // "cluster" → a k8s Deployment in kind owns the process; revoke tears it down.
    // "host"    → a developer runs the process manually; revoke just deletes the row.
    mode: text("mode").$type<WorkerMode>().notNull().default("cluster"),
    // Updated on every claim poll. A worker is "live" if this is within the
    // heartbeat threshold (30s). Null means the worker has never polled.
    // Uses timestamptz so JS Date values round-trip cleanly across server tz.
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_worker_last_seen_at").on(t.lastSeenAt)],
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
  | "definition_merged"
  | "definition_deleted"
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

// ---------------------------------------------------------------------------
// Task queue — request/task model for async agent work
// ---------------------------------------------------------------------------

export type RequestSource = "webhook" | "human";
export type RequestStatus =
  | "pending"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "done"
  | "failed";

/**
 * Raw work orders from webhooks or humans. The Worker Node's Planner Agent
 * claims a pending request, decides which skills to schedule, and emits one
 * task per skill. Human approval is required before the Executor begins
 * (unless the matched skill has auto_approve enabled).
 */
export const requests = pgTable(
  "request",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    source: text("source").$type<RequestSource>().notNull(),
    description: text("description").notNull(),
    context: jsonb("context").$type<unknown>(),
    messages: jsonb("messages")
      .$type<{ role: "planner" | "human"; content: string; timestamp: string }[]>()
      .notNull()
      .default([]),
    skillId: text("skill_id"),
    /**
     * Worker id that currently holds this request. Set atomically during
     * claim (FOR UPDATE SKIP LOCKED in claimRequest). Null means the
     * request is free — either pending (not yet claimed) or the claim was
     * released. Used for ownership checks on downstream mutations.
     */
    claimedBy: text("claimed_by"),
    status: text("status").$type<RequestStatus>().notNull().default("pending"),
    /**
     * Set on successful claim to `now() + stale_timeout`. The cron pass in
     * /api/cron/process-tasks resets any `planning` request whose `stale_at`
     * has passed back to `pending`, releasing claims held by dead workers.
     * Uses timestamptz so JS Date values round-trip cleanly across server tz.
     */
    staleAt: timestamp("stale_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_requests_status").on(t.status),
    index("idx_requests_stale_at").on(t.staleAt),
    index("idx_requests_claimed_by").on(t.claimedBy),
    check(
      "request_status_check",
      sql`${t.status} IN ('pending', 'planning', 'awaiting_approval', 'approved', 'done', 'failed')`
    ),
  ]
);

export type RunStatus = "draft" | "pending" | "claimed" | "done" | "failed";

/**
 * Units of work emitted by a Request. Each run carries a `skill_id` pointing
 * at a runbook the Executor Agent loads when it claims the run, plus
 * verifiable done criteria. Runs start as "draft" until the human approves
 * the request's plan (or "pending" directly when auto_approve).
 */
export const runs = pgTable(
  "run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    description: text("description").notNull(),
    doneCriteria: text("done_criteria").notNull(),
    status: text("status").$type<RunStatus>().notNull().default("draft"),
    args: jsonb("args").$type<Record<string, unknown>>(),
    claimedBy: text("claimed_by"),
    result: jsonb("result").$type<unknown>(),
    error: text("error"),
    // Per-run metrics (filled by the worker on completion). Aggregated from
    // the step-event stream so per-run summaries are queryable without
    // scanning every step row.
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    toolCallCount: integer("tool_call_count"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { mode: "date" }),
    staleAt: timestamp("stale_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (t) => [
    index("idx_runs_status").on(t.status),
    index("idx_runs_skill_status").on(t.skillId, t.status),
    index("idx_runs_stale_at").on(t.staleAt),
    index("idx_runs_request_id").on(t.requestId),
  ]
);

export type StepKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "finish"
  | "error";

/**
 * Per-step events captured from the Executor Agent's LLM iterations.
 * Each `onStepFinish` (one per LLM call) writes one or more rows here:
 *   - one `text` / `reasoning` row per emitted block,
 *   - one `tool_call` row per tool invocation,
 *   - one `tool_result` row per tool result,
 *   - finally a `finish` row carrying the step's usage and finishReason.
 *
 * Sequence is monotonic per run, assigned by the worker. Used for the
 * flowchart UI in the run detail and for SSE live-streaming.
 */
export const steps = pgTable(
  "run_step",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<StepKind>().notNull(),
    payload: jsonb("payload").$type<unknown>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_run_step_run_seq").on(t.runId, t.sequence),
    unique("uq_run_step_run_seq").on(t.runId, t.sequence),
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
