"use client";

import { ListChecks, Terminal, X } from "lucide-react";

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

export interface StepDetail {
  id: string;
  runId: string;
  workflowName: string;
  stepName: string;
  stepOrder: number;
  status: string;
  definitionKind: string;
  definitionName: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  /** Structured result of a successful step (e.g. stream name, S3 URI). */
  detail: Record<string, unknown> | null;
}

/** "streamName" → "Stream name", "s3Uri" → "S3 uri". */
function formatDetailKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface StepDetailPanelProps {
  step: StepDetail;
  onClose: () => void;
}

/**
 * Renders the step detail content. The parent (WorkflowsView) owns the
 * outer canvas-paper surface, the scroll container, and the splitter —
 * this component just paints content onto whatever paper it's mounted
 * on, so cards/panel read as one continuous notebook page.
 */
export function StepDetailPanel({ step, onClose }: StepDetailPanelProps) {
  const statusStyle = STATUS_STYLES[step.status] ?? STATUS_STYLES.pending;
  const durationMs =
    step.startedAt && step.finishedAt
      ? step.finishedAt.getTime() - step.startedAt.getTime()
      : null;

  return (
    <div className="flex flex-col gap-4 py-8 pl-4 pr-8">
      <div className="flex items-start gap-2">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="truncate text-sm font-semibold text-stone-800">
            {step.stepName}
          </h2>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle.bg} ${statusStyle.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
            {step.status}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-200/60 hover:text-stone-800"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="rounded-lg border border-stone-400 bg-[#f3eada] p-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[11px] sm:grid-cols-2">
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              Definition
            </dt>
            <dd className="mt-0.5 font-mono text-stone-800">
              {step.definitionKind} &quot;{step.definitionName}&quot;
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              Workflow run
            </dt>
            <dd className="mt-0.5 font-mono text-stone-800">
              {step.workflowName}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              Started
            </dt>
            <dd className="mt-0.5 text-stone-800">
              {step.startedAt ? TIME_FORMAT.format(step.startedAt) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              Finished
            </dt>
            <dd className="mt-0.5 text-stone-800">
              {step.finishedAt ? TIME_FORMAT.format(step.finishedAt) : "—"}
            </dd>
          </div>
          {durationMs !== null && (
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                Duration
              </dt>
              <dd className="mt-0.5 text-stone-800">
                {formatDuration(durationMs)}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              Step order
            </dt>
            <dd className="mt-0.5 text-stone-800">{step.stepOrder}</dd>
          </div>
        </dl>
      </div>

      {step.errorMessage && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-red-700">
            Error
          </div>
          <p className="mt-1 font-mono text-[11px] text-red-800">
            {step.errorMessage}
          </p>
        </div>
      )}

      <div className="rounded-lg border border-stone-400 bg-[#f3eada] p-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-stone-500" />
          <h3 className="text-xs font-semibold text-stone-800">
            Execution log
          </h3>
        </div>
        <div className="mt-3 rounded-md border border-dashed border-stone-400 bg-stone-50/40 p-4 text-[11px] text-stone-500">
          {step.status === "succeeded" ? (
            step.detail && Object.keys(step.detail).length > 0 ? (
              <dl className="space-y-1.5 font-mono text-stone-800">
                {Object.entries(step.detail).map(([k, v]) => (
                  <div key={k} className="flex flex-wrap gap-x-2">
                    <dt className="text-stone-500">{formatDetailKey(k)}</dt>
                    <dd className="break-all">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <>
                Step completed successfully
                {durationMs !== null
                  ? ` in ${formatDuration(durationMs)}`
                  : ""}
                {step.finishedAt
                  ? ` at ${TIME_FORMAT.format(step.finishedAt)}`
                  : ""}
                . No structured output was recorded for this step (this run
                predates per-step detail capture).
              </>
            )
          ) : step.status === "failed" ? (
            <>
              Step failed — see the error above. Full context is in the Vercel
              runtime logs.
            </>
          ) : step.status === "running" ? (
            <>Step is running…</>
          ) : step.status === "skipped" ? (
            <>
              Step was skipped because an earlier step in the chain failed.
            </>
          ) : (
            <>Step has not started yet.</>
          )}
        </div>
      </div>
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
