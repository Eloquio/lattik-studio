import { eq } from "drizzle-orm";
import { ArrowLeft, Terminal } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NavPanel } from "@/components/layout/nav-panel";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

export const dynamic = "force-dynamic";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: "bg-blue-500/10", text: "text-blue-600", dot: "bg-blue-500" },
  succeeded: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-600",
    dot: "bg-emerald-500",
  },
  failed: { bg: "bg-red-500/10", text: "text-red-600", dot: "bg-red-500" },
  pending: { bg: "bg-stone-200/40", text: "text-stone-500", dot: "bg-stone-400" },
  skipped: { bg: "bg-stone-200/40", text: "text-stone-500", dot: "bg-stone-400" },
};

export default async function StepDetailPage({
  params,
}: {
  params: Promise<{ stepId: string }>;
}) {
  const { stepId } = await params;
  const db = getDb();
  const [step] = await db
    .select()
    .from(schema.pipelineWorkflowSteps)
    .where(eq(schema.pipelineWorkflowSteps.id, stepId))
    .limit(1);

  if (!step) {
    notFound();
  }

  const [run] = await db
    .select()
    .from(schema.pipelineWorkflowRuns)
    .where(eq(schema.pipelineWorkflowRuns.id, step.runId))
    .limit(1);

  const statusStyle = STATUS_STYLES[step.status] ?? STATUS_STYLES.pending;
  const durationMs =
    step.startedAt && step.finishedAt
      ? step.finishedAt.getTime() - step.startedAt.getTime()
      : null;

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />

      <NavPanel />
      <main className="canvas-paper relative z-10 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
          <Link
            href="/workflows"
            className="inline-flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-800"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to workflows
          </Link>

          <div className="rounded-lg border border-stone-400 bg-[#f3eada] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-sm font-semibold text-stone-800">
                {step.stepName}
              </h1>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle.bg} ${statusStyle.text}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                {step.status}
              </span>
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-[11px] sm:grid-cols-2">
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                  Definition
                </dt>
                <dd className="font-mono text-stone-800">
                  {step.definitionKind} &quot;{step.definitionName}&quot;
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                  Workflow run
                </dt>
                <dd className="font-mono text-stone-800">
                  {run?.workflowName ?? "unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                  Started
                </dt>
                <dd className="text-stone-800">
                  {step.startedAt ? TIME_FORMAT.format(step.startedAt) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                  Finished
                </dt>
                <dd className="text-stone-800">
                  {step.finishedAt ? TIME_FORMAT.format(step.finishedAt) : "—"}
                </dd>
              </div>
              {durationMs !== null && (
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                    Duration
                  </dt>
                  <dd className="text-stone-800">{formatDuration(durationMs)}</dd>
                </div>
              )}
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                  Step order
                </dt>
                <dd className="text-stone-800">{step.stepOrder}</dd>
              </div>
            </dl>

            {step.errorMessage && (
              <div className="mt-4 rounded-md bg-red-50 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-red-700">
                  Error
                </div>
                <p className="mt-1 font-mono text-[11px] text-red-800">
                  {step.errorMessage}
                </p>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-stone-400 bg-[#f3eada] p-4">
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-stone-500" />
              <h2 className="text-xs font-semibold text-stone-800">
                Execution log
              </h2>
            </div>
            <div className="mt-3 rounded-md border border-dashed border-stone-400 bg-stone-50/50 p-4 text-[11px] text-stone-500">
              Execution logs will appear here once the workflow stops being a
              walking skeleton — today this step is a no-op that just records
              its status row, so there is nothing to stream.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSec}s`;
}
