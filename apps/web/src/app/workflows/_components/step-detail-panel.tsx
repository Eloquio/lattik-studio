"use client";

import { Terminal, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

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
}

interface StepDetailPanelProps {
  step: StepDetail | null;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}

export function StepDetailPanel({
  step,
  width,
  onWidthChange,
  onClose,
}: StepDetailPanelProps) {
  const isDragging = useRef(false);
  const handlersRef = useRef<{
    move: ((e: MouseEvent) => void) | null;
    up: (() => void) | null;
  }>({ move: null, up: null });

  // Clean up listeners on unmount in case a drag was still mid-flight.
  useEffect(() => {
    return () => {
      if (handlersRef.current.move) {
        document.removeEventListener("mousemove", handlersRef.current.move);
      }
      if (handlersRef.current.up) {
        document.removeEventListener("mouseup", handlersRef.current.up);
      }
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const windowWidth = window.innerWidth;
        const navWidth = 56; // mirrors NavPanel + canvas-panel math
        const availableWidth = windowWidth - navWidth;
        const newWidth =
          ((windowWidth - ev.clientX) / availableWidth) * 100;
        onWidthChange(Math.min(Math.max(newWidth, 25), 75));
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        handlersRef.current = { move: null, up: null };
      };

      if (handlersRef.current.move) {
        document.removeEventListener("mousemove", handlersRef.current.move);
      }
      if (handlersRef.current.up) {
        document.removeEventListener("mouseup", handlersRef.current.up);
      }

      handlersRef.current = { move: handleMouseMove, up: handleMouseUp };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [onWidthChange]
  );

  // Close on Escape so keyboard users aren't stuck.
  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, onClose]);

  if (!step) return null;

  const statusStyle = STATUS_STYLES[step.status] ?? STATUS_STYLES.pending;
  const durationMs =
    step.startedAt && step.finishedAt
      ? step.finishedAt.getTime() - step.startedAt.getTime()
      : null;

  return (
    <div
      className="relative flex h-full shrink-0"
      style={{ width: `${width}%` }}
    >
      <div
        className="absolute left-0 top-0 z-10 flex h-full w-3 cursor-col-resize items-center justify-center"
        onMouseDown={handleMouseDown}
      >
        <div className="h-8 w-0.5 rounded-full bg-stone-400/40" />
      </div>

      <div className="canvas-paper flex flex-1 flex-col overflow-hidden rounded-l-xl shadow-lg">
        <div className="flex items-center justify-between border-b border-stone-200 bg-white px-4 py-2 rounded-tl-xl">
          <span className="truncate font-mono text-sm font-medium text-stone-700">
            {step.stepName}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle.bg} ${statusStyle.text}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
              {step.status}
            </span>
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[11px] sm:grid-cols-2">
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
              <dd className="font-mono text-stone-800">{step.workflowName}</dd>
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
            <div className="rounded-md bg-red-50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-red-700">
                Error
              </div>
              <p className="mt-1 font-mono text-[11px] text-red-800">
                {step.errorMessage}
              </p>
            </div>
          )}

          <div>
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-stone-500" />
              <h2 className="text-xs font-semibold text-stone-800">
                Execution log
              </h2>
            </div>
            <div className="mt-2 rounded-md border border-dashed border-stone-400 bg-stone-50/50 p-4 text-[11px] text-stone-500">
              Execution logs will appear here once the workflow stops being a
              walking skeleton — today this step is a no-op that just records
              its status row, so there is nothing to stream.
            </div>
          </div>
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
