import { desc } from "drizzle-orm";
import { Activity, Clock, GitPullRequest, Timer } from "lucide-react";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { NavPanel } from "@/components/layout/nav-panel";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: "bg-blue-500/10", text: "text-blue-600", dot: "bg-blue-500" },
  succeeded: { bg: "bg-emerald-500/10", text: "text-emerald-600", dot: "bg-emerald-500" },
  failed: { bg: "bg-red-500/10", text: "text-red-600", dot: "bg-red-500" },
};

const FALLBACK_STYLE = {
  bg: "bg-stone-200/40",
  text: "text-stone-500",
  dot: "bg-stone-400",
};

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? FALLBACK_STYLE;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.bg} ${s.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  );
}

export default async function WorkflowsPage() {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pipelineWorkflowRuns)
    .orderBy(desc(schema.pipelineWorkflowRuns.startedAt))
    .limit(100);

  const activeCount = rows.filter((r) => r.status === "running").length;
  const succeededCount = rows.filter((r) => r.status === "succeeded").length;
  const failedCount = rows.filter((r) => r.status === "failed").length;

  return (
    <div className="flex h-screen overflow-hidden">
      <NavPanel />
      <main className="canvas-paper flex-1 overflow-auto">
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
            <div className="rounded-lg border border-stone-200 bg-[#f3eada] p-12 text-center">
              <p className="text-xs text-stone-500">
                No workflow runs yet. Merge a pipeline PR to trigger one.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((row) => {
                const s = STATUS_STYLES[row.status] ?? FALLBACK_STYLE;
                return (
                  <div
                    key={row.id}
                    className="group rounded-lg border border-stone-200 bg-[#f3eada] p-3 transition-shadow hover:shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs font-semibold text-stone-800">
                            {row.workflowName}
                          </span>
                          <StatusBadge status={row.status} />
                        </div>

                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400">
                          <span className="flex items-center gap-1">
                            <Clock className="h-2.5 w-2.5" />
                            started {TIME_FORMAT.format(row.startedAt)}
                          </span>
                          {row.finishedAt && (
                            <span className="flex items-center gap-1">
                              <Timer className="h-2.5 w-2.5" />
                              finished {TIME_FORMAT.format(row.finishedAt)}
                            </span>
                          )}
                          {row.errorMessage && (
                            <span className="flex items-center gap-1 text-red-600">
                              {row.errorMessage}
                            </span>
                          )}
                        </div>
                      </div>

                      {row.prUrl && (
                        <a
                          href={row.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600 transition-colors hover:bg-stone-200 hover:text-stone-800`}
                        >
                          <GitPullRequest className="h-2.5 w-2.5" />
                          PR
                        </a>
                      )}
                      {!row.prUrl && (
                        <span className={`inline-flex shrink-0 items-center text-[10px] ${s.text}`}>
                          —
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
