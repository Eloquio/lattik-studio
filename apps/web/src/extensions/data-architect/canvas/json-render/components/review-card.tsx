"use client";

import { Check, X } from "lucide-react";
import type { JsonRenderComponentProps } from "../types";

export function ReviewCard({ props, state, onStateChange }: JsonRenderComponentProps) {
  const suggestionId = props.suggestionId as string;
  const title = props.title as string;
  const description = props.description as string;
  const severity = (props.severity as string) ?? "info";

  const decision = state[`review_${suggestionId}`] as
    | "accepted"
    | "denied"
    | undefined;

  const borderColor =
    severity === "error"
      ? "border-red-300/50"
      : severity === "warning"
        ? "border-amber-300/50"
        : "border-blue-300/50";

  const bgColor =
    decision === "accepted"
      ? "bg-green-50/50"
      : decision === "denied"
        ? "bg-red-50/30"
        : "bg-white/80";

  return (
    <div
      className={`rounded-lg border ${borderColor} ${bgColor} px-3 py-2 transition-colors`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="text-xs font-semibold text-amber-900">{title}</div>
          <div className="mt-0.5 text-[11px] text-amber-700/70">
            {description}
          </div>
        </div>
        {!decision && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onStateChange(`review_${suggestionId}`, "accepted")}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-green-300/50 text-green-600 hover:bg-green-100/50 transition-colors"
              title="Accept"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onStateChange(`review_${suggestionId}`, "denied")}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-red-300/50 text-red-500 hover:bg-red-100/50 transition-colors"
              title="Deny"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {decision && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              decision === "accepted"
                ? "bg-green-100 text-green-700"
                : "bg-red-100 text-red-600"
            }`}
          >
            {decision}
          </span>
        )}
      </div>
    </div>
  );
}
