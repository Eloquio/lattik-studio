import { asc, desc, inArray } from "drizzle-orm";
import { Activity } from "lucide-react";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { NavPanel } from "@/components/layout/nav-panel";
import { WorkflowRunCard } from "./_components/workflow-run-card";

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

  type StepChain = {
    definitionId: string | null;
    definitionKind: string;
    definitionName: string;
    steps: { name: string; status: string }[];
  };

  // Webhook redelivery can produce duplicate step rows within the same
  // (runId, definitionId) — `seedLoggerTableStepsStep` runs again and
  // re-inserts. Dedupe by `stepOrder` per chain, keeping the most
  // advanced status (succeeded > failed > running > pending/skipped).
  // Without this the card renders the same checklist twice.
  const statusPriority: Record<string, number> = {
    succeeded: 4,
    failed: 3,
    running: 2,
    pending: 1,
    skipped: 0,
  };
  const chainsByRunKey = new Map<
    string,
    Map<string, StepChain & { stepsByOrder: Map<number, { name: string; status: string }> }>
  >();
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
      chain.stepsByOrder.set(s.stepOrder, { name: s.stepName, status: s.status });
    }
  }
  const stepsByRun = new Map<string, StepChain[]>();
  for (const [runId, chainsForRun] of chainsByRunKey) {
    stepsByRun.set(
      runId,
      Array.from(chainsForRun.values()).map((c) => ({
        definitionId: c.definitionId,
        definitionKind: c.definitionKind,
        definitionName: c.definitionName,
        steps: Array.from(c.stepsByOrder.entries())
          .sort(([a], [b]) => a - b)
          .map(([, step]) => step),
      })),
    );
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
      <main className="canvas-paper relative z-10 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-8">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-600" />
              <h2 className="text-sm font-semibold text-stone-800">Workflows</h2>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1">
                <span className="text-[11px] font-medium text-stone-500">
                  {rows.length} recent
                </span>
              </div>
              {activeCount > 0 && (
                <div className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  <span className="text-[11px] font-medium text-blue-700">
                    {activeCount} running
                  </span>
                </div>
              )}
              <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-medium text-emerald-700">
                  {succeededCount} succeeded
                </span>
              </div>
              {failedCount > 0 && (
                <div className="flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  <span className="text-[11px] font-medium text-red-700">
                    {failedCount} failed
                  </span>
                </div>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-lg border border-stone-400 bg-[#f3eada] p-12 text-center">
              <p className="text-xs text-stone-500">
                No workflow runs yet. Merge a pipeline PR to trigger one.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((row) => {
                const audit = row.prUrl ? auditByUrl.get(row.prUrl) : undefined;
                return (
                  <WorkflowRunCard
                    key={row.id}
                    workflowName={row.workflowName}
                    status={row.status}
                    startedAt={TIME_FORMAT.format(row.startedAt)}
                    finishedAt={
                      row.finishedAt ? TIME_FORMAT.format(row.finishedAt) : null
                    }
                    errorMessage={row.errorMessage}
                    prUrl={row.prUrl}
                    added={audit ? Array.from(audit.added) : []}
                    modified={audit ? Array.from(audit.modified) : []}
                    deleted={audit ? Array.from(audit.deleted) : []}
                    invalid={audit ? Array.from(audit.invalid) : []}
                    stepChains={stepsByRun.get(row.id) ?? []}
                  />
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
