import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { NavPanel } from "@/components/layout/nav-panel";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  running: "bg-sky-500/20 text-sky-200 border-sky-400/30",
  succeeded: "bg-emerald-500/20 text-emerald-200 border-emerald-400/30",
  failed: "bg-rose-500/20 text-rose-200 border-rose-400/30",
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
  const style = STATUS_STYLES[status] ?? "bg-white/10 text-white/70 border-white/15";
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${style}`}>
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

  return (
    <div className="flex h-screen overflow-hidden">
      <NavPanel />
      <main className="flex-1 overflow-auto p-8">
        <header className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold text-white">Workflows</h1>
          <p className="text-xs text-white/40">
            Showing the {rows.length} most recent runs.
          </p>
        </header>

        <div className="overflow-hidden rounded-lg border border-white/10 bg-white/5 backdrop-blur-xl">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wide text-white/50">
              <tr>
                <th className="px-4 py-3">Workflow</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Finished</th>
                <th className="px-4 py-3">PR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-white/80">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-white/40">
                    No workflow runs yet. Merge a pipeline PR to trigger one.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-white/5">
                    <td className="px-4 py-3 font-mono text-xs text-white/90">
                      {row.workflowName}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-white/60">
                      {TIME_FORMAT.format(row.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-white/60">
                      {row.finishedAt ? TIME_FORMAT.format(row.finishedAt) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {row.prUrl ? (
                        <a
                          href={row.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand hover:underline"
                        >
                          View
                        </a>
                      ) : (
                        <span className="text-white/30">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
