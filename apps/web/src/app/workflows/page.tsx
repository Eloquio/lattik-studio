import { asc, desc, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { NavPanel } from "@/components/layout/nav-panel";
import type { StepDetail } from "./_components/step-detail-panel";
import type { StepChain } from "./_components/workflow-run-card";
import {
  WorkflowsView,
  type RunCardData,
} from "./_components/workflows-view";

export const dynamic = "force-dynamic";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// The audit log `detail` string ends with a phrase describing the action
// ("added", "modified", "deleted"). The expanded section already groups by
// action, so we trim the trailing verb for a tighter line. Validation
// failures keep the colon-and-message suffix so the reason is visible.
function detailToLabel(detail: string | null): string {
  if (!detail) return "(no detail)";
  return detail
    .replace(/ added$/, "")
    .replace(/ modified$/, "")
    .replace(/ deleted$/, "")
    // Legacy entries from before the reconcile rewrite — keep readable.
    .replace(/ marked as merged$/, "")
    .replace(/ deleted after deletion PR merged$/, "");
}

export default async function WorkflowsPage() {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pipelineWorkflowRuns)
    .orderBy(desc(schema.pipelineWorkflowRuns.startedAt))
    .limit(100);

  const runIds = rows.map((r) => r.id);
  const prUrls = rows
    .map((r) => r.prUrl)
    .filter((u): u is string => Boolean(u));

  // Per-definition step checklists (currently only logger_table). Order by
  // runId then stepOrder so we can group in JS without another sort.
  const stepRows =
    runIds.length > 0
      ? await db
          .select()
          .from(schema.pipelineWorkflowSteps)
          .where(inArray(schema.pipelineWorkflowSteps.runId, runIds))
          .orderBy(
            asc(schema.pipelineWorkflowSteps.runId),
            asc(schema.pipelineWorkflowSteps.definitionName),
            asc(schema.pipelineWorkflowSteps.stepOrder),
          )
      : [];

  const runById = new Map(rows.map((r) => [r.id, r]));

  // Webhook redelivery can produce duplicate step rows within the same
  // (runId, definitionId) — `seedLoggerTableStepsStep` runs again and
  // re-inserts. Dedupe by `stepOrder` per chain, keeping the most
  // advanced status (succeeded > failed > running > pending/skipped).
  // Without this the card renders the same checklist twice. We also pick
  // the row whose status wins as the canonical row whose `id` carries
  // into the side panel — so the panel always reads from the latest
  // attempt's metadata, not a stale earlier duplicate.
  const statusPriority: Record<string, number> = {
    succeeded: 4,
    failed: 3,
    running: 2,
    pending: 1,
    skipped: 0,
  };
  type DedupedStep = {
    id: string;
    name: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    errorMessage: string | null;
    stepOrder: number;
  };
  type ChainAccumulator = StepChain & {
    stepsByOrder: Map<number, DedupedStep>;
  };
  const chainsByRunKey = new Map<string, Map<string, ChainAccumulator>>();
  for (const s of stepRows) {
    const chainKey = `${s.definitionId ?? ""}::${s.definitionName}`;
    let chainsForRun = chainsByRunKey.get(s.runId);
    if (!chainsForRun) {
      chainsForRun = new Map();
      chainsByRunKey.set(s.runId, chainsForRun);
    }
    let chain = chainsForRun.get(chainKey);
    if (!chain) {
      chain = {
        definitionId: s.definitionId,
        definitionKind: s.definitionKind,
        definitionName: s.definitionName,
        steps: [],
        stepsByOrder: new Map(),
      };
      chainsForRun.set(chainKey, chain);
    }
    const prev = chain.stepsByOrder.get(s.stepOrder);
    if (
      !prev ||
      (statusPriority[s.status] ?? -1) > (statusPriority[prev.status] ?? -1)
    ) {
      chain.stepsByOrder.set(s.stepOrder, {
        id: s.id,
        name: s.stepName,
        status: s.status,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        errorMessage: s.errorMessage,
        stepOrder: s.stepOrder,
      });
    }
  }

  const stepsByRun = new Map<string, StepChain[]>();
  const stepDetails: Record<string, StepDetail> = {};
  for (const [runId, chainsForRun] of chainsByRunKey) {
    const run = runById.get(runId);
    const chains: StepChain[] = [];
    for (const c of chainsForRun.values()) {
      const ordered = Array.from(c.stepsByOrder.entries())
        .sort(([a], [b]) => a - b)
        .map(([, step]) => step);
      chains.push({
        definitionId: c.definitionId,
        definitionKind: c.definitionKind,
        definitionName: c.definitionName,
        steps: ordered.map((o) => ({
          id: o.id,
          name: o.name,
          status: o.status,
        })),
      });
      for (const step of ordered) {
        stepDetails[step.id] = {
          id: step.id,
          runId,
          workflowName: run?.workflowName ?? "unknown",
          stepName: step.name,
          stepOrder: step.stepOrder,
          status: step.status,
          definitionKind: c.definitionKind,
          definitionName: c.definitionName,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
          errorMessage: step.errorMessage,
        };
      }
    }
    stepsByRun.set(runId, chains);
  }

  const auditRows =
    prUrls.length > 0
      ? await db
          .select({
            prUrl: schema.webhookAuditLog.prUrl,
            action: schema.webhookAuditLog.action,
            detail: schema.webhookAuditLog.detail,
          })
          .from(schema.webhookAuditLog)
          .where(inArray(schema.webhookAuditLog.prUrl, prUrls))
      : [];

  // Webhook redelivery can produce multiple audit rows per definition per
  // PR. We dedupe by formatted label so each definition shows up once per
  // bucket, regardless of how many times the webhook fired.
  const auditByUrl = new Map<
    string,
    {
      added: Set<string>;
      modified: Set<string>;
      deleted: Set<string>;
      invalid: Set<string>;
    }
  >();
  for (const a of auditRows) {
    const entry =
      auditByUrl.get(a.prUrl) ??
      {
        added: new Set<string>(),
        modified: new Set<string>(),
        deleted: new Set<string>(),
        invalid: new Set<string>(),
      };
    if (a.action === "definition_added") {
      entry.added.add(detailToLabel(a.detail));
    } else if (a.action === "definition_modified") {
      entry.modified.add(detailToLabel(a.detail));
    } else if (a.action === "definition_deleted") {
      entry.deleted.add(detailToLabel(a.detail));
    } else if (a.action === "validation_failed") {
      // Keep the full ":reason" suffix — that's the point of this bucket.
      entry.invalid.add(a.detail ?? "(no detail)");
    }
    auditByUrl.set(a.prUrl, entry);
  }

  const activeCount = rows.filter((r) => r.status === "running").length;
  const succeededCount = rows.filter((r) => r.status === "succeeded").length;
  const failedCount = rows.filter((r) => r.status === "failed").length;

  const cards: RunCardData[] = rows.map((row) => {
    const audit = row.prUrl ? auditByUrl.get(row.prUrl) : undefined;
    return {
      id: row.id,
      workflowName: row.workflowName,
      status: row.status,
      startedAt: TIME_FORMAT.format(row.startedAt),
      finishedAt: row.finishedAt ? TIME_FORMAT.format(row.finishedAt) : null,
      errorMessage: row.errorMessage,
      prUrl: row.prUrl,
      added: audit ? Array.from(audit.added) : [],
      modified: audit ? Array.from(audit.modified) : [],
      deleted: audit ? Array.from(audit.deleted) : [],
      invalid: audit ? Array.from(audit.invalid) : [],
      stepChains: stepsByRun.get(row.id) ?? [],
    };
  });

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      {/* Background image + blur — matches the chat page so the NavPanel
          renders against the same glassmorphic backdrop. */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      <NavPanel />
      <WorkflowsView
        cards={cards}
        stepDetails={stepDetails}
        activeCount={activeCount}
        succeededCount={succeededCount}
        failedCount={failedCount}
      />
    </div>
  );
}
