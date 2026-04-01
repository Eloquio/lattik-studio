"use client";

import { useState } from "react";
import { Check, AlertCircle, ChevronDown, ChevronUp, Loader2, Wrench } from "lucide-react";

const toolLabels: Record<string, string> = {
  handoff: "Handoff",
  updatePipeline: "Update Pipeline",
  generateYaml: "Generate YAML",
};

function formatToolName(name: string): string {
  if (toolLabels[name]) return toolLabels[name];
  return name.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim();
}

interface ToolResultProps {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
}

export function ToolResult({ toolName, state, input, output }: ToolResultProps) {
  const [expanded, setExpanded] = useState(false);

  const isLoading = state === "input-streaming" || state === "input-available";
  const isError = state === "output-error";
  const isDone = state === "output-available";

  const label = formatToolName(toolName) + (isLoading ? "..." : "");

  return (
    <div className="my-1">
      <button
        onClick={() => {
          if (isDone || isError) setExpanded((prev) => !prev);
        }}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition-colors ${
          isError
            ? "border-red-500/20 bg-red-500/5"
            : "border-white/10 bg-white/5 hover:bg-white/[0.08]"
        }`}
      >
        {isLoading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#e0a96e]" />
        ) : isError ? (
          <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
        ) : isDone ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-white/30" />
        )}

        <span className={`flex-1 text-xs ${isError ? "text-red-300" : "text-white/50"}`}>
          {label}
        </span>

        {(isDone || isError) && (
          expanded ? (
            <ChevronUp className="h-3 w-3 shrink-0 text-white/30" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 text-white/30" />
          )
        )}
      </button>

      {expanded && (
        <div className="mt-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
          {input != null && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/30">
                Input
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-white/50">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {isDone && output != null && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/30">
                Output
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-white/50">
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
          {isError && output != null && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/30">
                Error
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-red-300/70">
                {typeof output === "object" && output && "errorText" in output
                  ? String((output as { errorText: string }).errorText)
                  : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
