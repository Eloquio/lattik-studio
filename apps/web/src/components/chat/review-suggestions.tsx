"use client";

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type { ReviewSuggestion } from "@/extensions/data-architect/tools/review-definition";

interface ReviewSuggestionsProps {
  suggestions: ReviewSuggestion[];
  onApply?: (changes: Array<{ path: string; value: unknown }>) => void;
  onComplete?: (summary: string) => void;
}

export function ReviewSuggestions({ suggestions, onApply, onComplete }: ReviewSuggestionsProps) {
  const [decisions, setDecisions] = useState<Record<string, "accepted" | "denied">>({});
  const completedRef = useRef(false);

  const handleDecision = (s: ReviewSuggestion, decision: "accepted" | "denied") => {
    setDecisions((prev) => ({ ...prev, [s.id]: decision }));
    if (decision === "accepted" && s.actions?.length && onApply) {
      onApply(s.actions);
    }
  };

  // Auto-advance when all suggestions are decided
  const allDecided = suggestions.length > 0 && suggestions.every((s) => s.id in decisions);
  useEffect(() => {
    if (allDecided && !completedRef.current && onComplete) {
      completedRef.current = true;
      const lines = suggestions.map((s) => {
        const d = decisions[s.id];
        return `- ${d === "accepted" ? "Accepted" : "Denied"}: "${s.title}"`;
      });
      onComplete(`All suggestions reviewed:\n${lines.join("\n")}\n\nProceed to the next step.`);
    }
  }, [allDecided, decisions, suggestions, onComplete]);

  const severityBorder = (sev: string) =>
    sev === "error" ? "border-red-500/40" : sev === "warning" ? "border-amber-500/40" : "border-blue-400/30";

  return (
    <div className="my-2 flex flex-col gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
        Review Suggestions
      </span>
      {suggestions.map((s) => {
        const d = decisions[s.id];
        return (
          <div
            key={s.id}
            className={`rounded-lg border ${severityBorder(s.severity)} px-3 py-2 transition-colors ${
              d === "accepted" ? "bg-green-500/10" : d === "denied" ? "bg-red-500/10" : "bg-white/5"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="text-xs font-semibold text-white/90">{s.title}</div>
                <div className="mt-0.5 text-[11px] text-white/60">{s.description}</div>
              </div>
              {!d && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleDecision(s, "accepted")}
                    className="flex h-6 w-6 items-center justify-center rounded-md border border-green-500/30 text-green-400 hover:bg-green-500/20 transition-colors"
                    title="Accept"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDecision(s, "denied")}
                    className="flex h-6 w-6 items-center justify-center rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors"
                    title="Deny"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {d && (
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    d === "accepted" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {d}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
