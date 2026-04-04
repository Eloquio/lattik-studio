"use client";

import type { JsonRenderComponentProps } from "../types";

const statusStyles: Record<string, { bg: string; text: string; dot: string }> = {
  draft: { bg: "bg-amber-100/50", text: "text-amber-700", dot: "bg-amber-400" },
  reviewing: { bg: "bg-blue-100/50", text: "text-blue-700", dot: "bg-blue-400" },
  "checks-passed": { bg: "bg-green-100/50", text: "text-green-700", dot: "bg-green-400" },
  "checks-failed": { bg: "bg-red-100/50", text: "text-red-700", dot: "bg-red-400" },
  "pr-submitted": { bg: "bg-purple-100/50", text: "text-purple-700", dot: "bg-purple-400" },
  merged: { bg: "bg-green-100/50", text: "text-green-700", dot: "bg-green-500" },
};

export function StatusBadge({ props }: JsonRenderComponentProps) {
  const status = props.status as string;
  const label = (props.label as string) ?? status;
  const step = props.step as string | undefined;

  const style = statusStyles[status] ?? statusStyles.draft;

  return (
    <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 ${style.bg}`}>
      <div className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      <span className={`text-[11px] font-medium ${style.text}`}>{label}</span>
      {step && (
        <span className="text-[10px] text-amber-600/50">{step}</span>
      )}
    </div>
  );
}
