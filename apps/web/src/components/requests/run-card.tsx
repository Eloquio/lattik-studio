"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RunStatus, runs } from "@/db/schema";
import { RunFlowchart } from "./run-flowchart";

type RunRow = typeof runs.$inferSelect;

const RUN_STATUS_COLOR: Record<RunStatus, string> = {
  draft: "bg-white/5 text-white/50",
  pending: "bg-white/10 text-white/60",
  claimed: "bg-sky-400/15 text-sky-300",
  done: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
};

function formatDateTime(date: Date | string | null | undefined) {
  if (!date) return "—";
  return new Date(date).toLocaleString();
}

export function RunCard({ run }: { run: RunRow }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-white/40" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-white/40" />
        )}
        <span className="flex-1 truncate text-xs text-white/80">
          <DescriptionWithLinks text={run.description} />
        </span>
        <span className="text-[10px] text-white/40">{run.skillId}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${RUN_STATUS_COLOR[run.status]}`}
        >
          {run.status}
        </span>
      </button>

      <div className="px-3 pb-3 text-[11px] text-white/50">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-white/30">
          <span>{run.id}</span>
          <RunHeaderTokens run={run} />
        </p>
        <p className="mt-1">Done when: {run.doneCriteria}</p>
        <RunMetricsLine run={run} />
        {run.error && (
          <p className="mt-1 text-red-300/80">{run.error}</p>
        )}
      </div>

      {open && (
        <div className="border-t border-white/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Timeline
          </div>
          <Timeline run={run} />

          <div className="mt-3 text-[10px] uppercase tracking-wider text-white/40">
            Steps
          </div>
          <div className="mt-1">
            <RunFlowchart
              runId={run.id}
              isTerminal={run.status === "done" || run.status === "failed"}
            />
          </div>

          {run.result !== null && run.result !== undefined && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-white/40">
                Result
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 p-2 text-[10px] text-white/70">
                {JSON.stringify(run.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Split a string into text + URL chunks so URLs render as <a> tags. The
// descriptions we care about (webhook-generated "Post-merge actions for …")
// only ever embed one URL; this also handles arbitrary text with zero or
// more URLs without surprises.
const URL_RE = /(https?:\/\/[^\s)]+)/g;
const URL_TEST = /^https?:\/\//;

function DescriptionWithLinks({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        URL_TEST.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-white/30 underline-offset-2 hover:decoration-white/70"
            onClick={(e) => e.stopPropagation()}
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function RunHeaderTokens({ run }: { run: RunRow }) {
  const inT = run.inputTokens ?? 0;
  const outT = run.outputTokens ?? 0;
  if (inT + outT === 0) return null;
  return (
    <span
      className="font-mono text-[10px] text-white/40"
      title={`${inT.toLocaleString()} input · ${outT.toLocaleString()} output`}
    >
      {compactNum(inT)} in / {compactNum(outT)} out
    </span>
  );
}

function compactNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}m` : `${m.toFixed(1)}m`;
}

function RunMetricsLine({ run }: { run: RunRow }) {
  const parts: string[] = [];
  if (run.model) parts.push(run.model);
  const tokens =
    (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  if (tokens > 0) {
    parts.push(
      `${run.inputTokens ?? 0} in / ${run.outputTokens ?? 0} out tokens`,
    );
  }
  if (run.toolCallCount && run.toolCallCount > 0) {
    parts.push(`${run.toolCallCount} tool ${run.toolCallCount === 1 ? "call" : "calls"}`);
  }
  if (run.claimedAt && run.completedAt) {
    const ms = new Date(run.completedAt).getTime() - new Date(run.claimedAt).getTime();
    parts.push(formatDuration(ms));
  }
  if (parts.length === 0) return null;
  return <p className="mt-1 text-[10px] text-white/30">{parts.join(" · ")}</p>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s - m * 60);
  return `${m}m${rs}s`;
}

interface TimelineEvent {
  at: Date;
  kind: "created" | "claimed" | "done" | "failed";
  label: string;
  detail?: string;
}

function buildTimeline(run: RunRow): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  events.push({
    at: new Date(run.createdAt),
    kind: "created",
    label: "Created",
  });
  if (run.claimedAt) {
    events.push({
      at: new Date(run.claimedAt),
      kind: "claimed",
      label: "Claimed",
      detail: run.claimedBy ?? undefined,
    });
  }
  if (run.completedAt) {
    if (run.status === "failed") {
      events.push({
        at: new Date(run.completedAt),
        kind: "failed",
        label: "Failed",
        detail: run.error ?? undefined,
      });
    } else if (run.status === "done") {
      events.push({
        at: new Date(run.completedAt),
        kind: "done",
        label: "Done",
      });
    }
  }
  return events;
}

function Timeline({ run }: { run: RunRow }) {
  const events = buildTimeline(run);
  const start = events[0]?.at.getTime() ?? Date.now();

  const dotColor: Record<TimelineEvent["kind"], string> = {
    created: "bg-white/40",
    claimed: "bg-sky-400",
    done: "bg-emerald-400",
    failed: "bg-red-400",
  };

  return (
    <ol className="mt-1 flex flex-col gap-1.5">
      {events.map((evt, idx) => {
        const ms = evt.at.getTime() - start;
        return (
          <li key={idx} className="flex items-start gap-2 text-[11px]">
            <span
              className={`mt-1 size-1.5 shrink-0 rounded-full ${dotColor[evt.kind]}`}
            />
            <span className="w-14 shrink-0 font-mono text-[10px] text-white/40">
              {formatOffset(ms)}
            </span>
            <span className="text-white/70">{evt.label}</span>
            {evt.detail && (
              <span className="flex-1 truncate text-white/50">
                · {evt.detail}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-white/30">
              {formatDateTime(evt.at)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function formatOffset(ms: number): string {
  if (ms === 0) return "t0";
  if (ms < 1000) return `+${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `+${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s - m * 60);
  return `+${m}m${rs}s`;
}
