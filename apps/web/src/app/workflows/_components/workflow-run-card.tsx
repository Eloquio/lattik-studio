"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  GitPullRequest,
  Timer,
} from "lucide-react";

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

interface WorkflowRunCardProps {
  workflowName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  prUrl: string | null;
  added: string[];
  modified: string[];
  deleted: string[];
  invalid: string[];
}

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

export function WorkflowRunCard({
  workflowName,
  status,
  startedAt,
  finishedAt,
  errorMessage,
  prUrl,
  added,
  modified,
  deleted,
  invalid,
}: WorkflowRunCardProps) {
  const [open, setOpen] = useState(false);
  const hasDetails =
    added.length > 0 ||
    modified.length > 0 ||
    deleted.length > 0 ||
    invalid.length > 0 ||
    Boolean(errorMessage);

  return (
    <div className="group rounded-lg border border-stone-400 bg-[#f3eada] transition-shadow hover:shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <span className="mt-0.5 shrink-0 text-stone-500">
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-mono text-xs font-semibold text-stone-800">
              {workflowName}
            </span>
            <StatusBadge status={status} />
            {added.length > 0 && (
              <span className="text-[10px] text-stone-500">
                {added.length} added
              </span>
            )}
            {modified.length > 0 && (
              <span className="text-[10px] text-stone-500">
                {modified.length} modified
              </span>
            )}
            {deleted.length > 0 && (
              <span className="text-[10px] text-stone-500">
                {deleted.length} deleted
              </span>
            )}
            {invalid.length > 0 && (
              <span className="text-[10px] text-red-600">
                {invalid.length} invalid
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              started {startedAt}
            </span>
            {finishedAt && (
              <span className="flex items-center gap-1">
                <Timer className="h-2.5 w-2.5" />
                finished {finishedAt}
              </span>
            )}
            {errorMessage && !open && (
              <span className="flex items-center gap-1 text-red-600">
                {errorMessage}
              </span>
            )}
          </div>
        </div>

        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600 transition-colors hover:bg-stone-200 hover:text-stone-800"
          >
            <GitPullRequest className="h-2.5 w-2.5" />
            PR
          </a>
        )}
      </button>

      {open && (
        <div className="border-t border-stone-300 px-3 pb-3 pt-2 text-[11px] text-stone-700">
          {hasDetails ? (
            <div className="flex flex-col gap-3">
              {added.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                    Added ({added.length})
                  </div>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
                    {added.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {modified.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                    Modified ({modified.length})
                  </div>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
                    {modified.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {deleted.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                    Deleted ({deleted.length})
                  </div>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
                    {deleted.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {invalid.length > 0 && (
                <div className="rounded-md bg-red-50 p-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-red-700">
                    Invalid ({invalid.length})
                  </div>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono text-red-800">
                    {invalid.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {errorMessage && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-red-600">
                    Error
                  </div>
                  <p className="mt-1 font-mono text-red-700">{errorMessage}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-stone-500">
              No definition changes recorded for this run.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
