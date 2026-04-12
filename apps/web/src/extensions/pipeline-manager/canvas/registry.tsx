"use client";

import { defineRegistry } from "@json-render/react";
import { Activity, Clock, Eye, Pause, Zap, Timer } from "lucide-react";
import { catalog } from "./catalog";

// ---- Status colors ----
const STATE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  success: { bg: "bg-emerald-500/10", text: "text-emerald-600", dot: "bg-emerald-500" },
  failed: { bg: "bg-red-500/10", text: "text-red-600", dot: "bg-red-500" },
  running: { bg: "bg-blue-500/10", text: "text-blue-600", dot: "bg-blue-500" },
  queued: { bg: "bg-amber-500/10", text: "text-amber-600", dot: "bg-amber-400" },
  active: { bg: "bg-emerald-500/10", text: "text-emerald-600", dot: "bg-emerald-500" },
  paused: { bg: "bg-stone-400/10", text: "text-stone-500", dot: "bg-stone-400" },
  inactive: { bg: "bg-stone-300/10", text: "text-stone-400", dot: "bg-stone-300" },
  none: { bg: "bg-stone-200/10", text: "text-stone-300", dot: "bg-stone-200" },
};

function stateColor(state: string) {
  return STATE_COLORS[state] ?? STATE_COLORS.none;
}

export const { registry } = defineRegistry(catalog, {
  components: {
    Section: ({ children }) => (
      <div className="flex flex-col gap-4">{children}</div>
    ),

    OverviewHeader: ({ props }) => (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-amber-600" />
          <h2 className="text-sm font-semibold text-stone-800">Pipeline Overview</h2>
        </div>
        <div className="flex gap-3">
          <div className="flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1">
            <span className="text-[11px] font-medium text-stone-500">{props.dagCount} DAGs</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span className="text-[11px] font-medium text-emerald-700">{props.activeCount} active</span>
          </div>
          {props.pausedCount > 0 && (
            <div className="flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1">
              <Pause className="h-2.5 w-2.5 text-stone-400" />
              <span className="text-[11px] font-medium text-stone-500">{props.pausedCount} paused</span>
            </div>
          )}
        </div>
      </div>
    ),

    DagCard: ({ props }) => {
      const sc = stateColor(props.status);
      const lastSc = stateColor(props.lastRunState);
      return (
        <div className="group rounded-lg border border-stone-200 bg-white p-3 transition-shadow hover:shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {/* DAG name + status badge */}
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-semibold text-stone-800">
                  {props.dagId}
                </span>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${sc.bg} ${sc.text}`}>
                  <span className={`h-1 w-1 rounded-full ${sc.dot}`} />
                  {props.status}
                </span>
              </div>

              {/* Description */}
              {props.description && (
                <p className="truncate text-[11px] text-stone-500">{props.description}</p>
              )}

              {/* Meta row */}
              <div className="flex items-center gap-3 text-[10px] text-stone-400">
                <span className="flex items-center gap-1">
                  <Clock className="h-2.5 w-2.5" />
                  {props.schedule === "none" ? "manual" : props.schedule}
                </span>
                <span className="flex items-center gap-1">
                  <Eye className="h-2.5 w-2.5" />
                  last run:
                  <span className={`font-medium ${lastSc.text}`}>{props.lastRunState}</span>
                </span>
              </div>
            </div>

            {/* Run history dots */}
            <div className="flex shrink-0 items-center gap-0.5 pt-1" title="Last 10 runs (newest first)">
              {props.recentRuns.map((state, i) => {
                const rc = stateColor(state);
                return (
                  <span
                    key={i}
                    className={`h-2.5 w-2.5 rounded-sm ${rc.dot} ${i === 0 ? "ring-1 ring-stone-300/50" : ""}`}
                    title={state}
                  />
                );
              })}
            </div>
          </div>
        </div>
      );
    },

    RunDetailHeader: ({ props }) => {
      const sc = stateColor(props.state);
      return (
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-amber-600" />
                <span className="text-xs font-semibold text-stone-800">{props.dagId}</span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-stone-500">
                <span className="flex items-center gap-1">
                  <Clock className="h-2.5 w-2.5" />
                  {props.logicalDate}
                </span>
                {props.startDate && (
                  <span className="flex items-center gap-1">
                    <Timer className="h-2.5 w-2.5" />
                    {props.startDate}
                  </span>
                )}
              </div>
            </div>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${sc.bg} ${sc.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />
              {props.state}
            </span>
          </div>
        </div>
      );
    },

    TaskRow: ({ props }) => {
      const sc = stateColor(props.state);
      const isSensor = props.taskType === "sensor";
      return (
        <div className="flex items-center gap-3 rounded-md border border-stone-100 bg-white px-3 py-2">
          {/* Status dot */}
          <span className={`h-2 w-2 shrink-0 rounded-full ${sc.dot}`} />

          {/* Task icon + name */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isSensor ? (
              <Eye className="h-3 w-3 shrink-0 text-stone-400" />
            ) : (
              <Zap className="h-3 w-3 shrink-0 text-amber-500" />
            )}
            <span className="truncate text-xs font-medium text-stone-700">{props.taskId}</span>
            <span className="shrink-0 rounded bg-stone-100 px-1 py-0.5 text-[9px] font-medium text-stone-500">
              {props.taskType}
            </span>
          </div>

          {/* Duration */}
          <span className="shrink-0 text-[11px] tabular-nums text-stone-500">
            {props.duration}
          </span>

          {/* State badge */}
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${sc.bg} ${sc.text}`}>
            {props.state}
          </span>

          {/* Try count */}
          {props.tryNumber > 1 && (
            <span className="shrink-0 text-[10px] text-stone-400">
              try {props.tryNumber}
            </span>
          )}
        </div>
      );
    },
  },
});
