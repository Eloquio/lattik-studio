"use client";

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type {
  ReviewAction,
  ReviewSuggestion,
} from "@/extensions/data-architect/tools/review-definition";

function prettyPath(jsonPointer: string): string {
  if (!jsonPointer.startsWith("/")) return jsonPointer;
  const parts = jsonPointer.slice(1).split("/");
  return parts.reduce((acc, p, i) => {
    if (/^\d+$/.test(p)) return `${acc}[${p}]`;
    return i === 0 ? p : `${acc}.${p}`;
  }, "");
}

type Leaf = { path: string; value: unknown };

function flattenValue(basePath: string, value: unknown): Leaf[] {
  if (value === null || typeof value !== "object") {
    return [{ path: basePath, value }];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: basePath, value: "(empty list)" }];
    return value.flatMap((v, i) => flattenValue(`${basePath}[${i}]`, v));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [{ path: basePath, value: "(empty object)" }];
  return entries.flatMap(([k, v]) => flattenValue(`${basePath}.${k}`, v));
}

function formatLeaf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return String(value);
}

function ActionPreview({ actions }: { actions: ReviewAction[] }) {
  if (actions.length === 0) return null;
  const leaves = actions.flatMap((a) => flattenValue(prettyPath(a.path), a.value));
  return (
    <div className="mt-1.5 flex flex-col gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1">
      {leaves.map((leaf, i) => (
        <div key={`${leaf.path}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-mono text-[10px] text-white/50">{leaf.path}</span>
          <span className="text-[10px] text-white/30">→</span>
          <span className="whitespace-pre-wrap break-words text-[11px] leading-snug text-white/85">
            {formatLeaf(leaf.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface ReviewStatus {
  decisions?: Record<string, "accepted" | "denied">;
  completed?: boolean;
}

interface ReviewSuggestionsProps {
  suggestions: ReviewSuggestion[];
  onApply?: (changes: Array<{ path: string; value: unknown }>) => void;
  onComplete?: (summary: string) => void;
  initialStatus?: ReviewStatus;
  onStatus?: (next: ReviewStatus) => void;
}

export function ReviewSuggestions({
  suggestions,
  onApply,
  onComplete,
  initialStatus,
  onStatus,
}: ReviewSuggestionsProps) {
  const [decisions, setDecisions] = useState<Record<string, "accepted" | "denied">>(
    () => initialStatus?.decisions ?? {}
  );
  // Seeded from persisted status so a refresh after the review wrapped up does
  // not re-fire onComplete (which would spam the thread with another summary).
  const completedRef = useRef(initialStatus?.completed ?? false);

  const handleDecision = (s: ReviewSuggestion, decision: "accepted" | "denied") => {
    const next = { ...decisions, [s.id]: decision };
    setDecisions(next);
    if (decision === "accepted" && s.actions.length > 0 && onApply) {
      onApply(s.actions);
    }
    onStatus?.({ decisions: next, completed: completedRef.current });
  };

  // Auto-advance when all suggestions are decided. When suggestions is empty,
  // the reviewer found nothing actionable — fire onComplete immediately so the
  // agent moves on to the next workflow step without waiting for user input.
  const allDecided = suggestions.length > 0 && suggestions.every((s) => s.id in decisions);
  useEffect(() => {
    if (completedRef.current || !onComplete) return;
    if (suggestions.length === 0) {
      completedRef.current = true;
      onComplete("Review complete: no issues found. Proceed to the next step.");
      onStatus?.({ decisions: {}, completed: true });
      return;
    }
    if (allDecided) {
      completedRef.current = true;
      const lines = suggestions.map((s) => {
        const d = decisions[s.id];
        return `- ${d === "accepted" ? "Accepted" : "Denied"}: "${s.title}"`;
      });
      onComplete(`All suggestions reviewed:\n${lines.join("\n")}\n\nProceed to the next step.`);
      onStatus?.({ decisions, completed: true });
    }
  }, [allDecided, decisions, suggestions, onComplete, onStatus]);

  if (suggestions.length === 0) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span>Review complete — no issues found.</span>
      </div>
    );
  }

  return (
    <div className="my-2 flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
        Review Suggestions
      </span>
      {suggestions.map((s) => {
        const d = decisions[s.id];
        return (
          <div
            key={s.id}
            className={`rounded-lg border border-white/10 px-3 py-1.5 transition-colors ${
              d === "accepted" ? "bg-green-500/10" : d === "denied" ? "bg-red-500/10" : "bg-white/5"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="text-xs font-semibold text-white/90">{s.title}</div>
                <div className="mt-0.5 text-[11px] text-white/60">{s.description}</div>
                <ActionPreview actions={s.actions} />
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
