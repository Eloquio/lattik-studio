"use client";

import { useState } from "react";
import { Check, AlertCircle, ChevronDown, ChevronUp, Loader2, Wrench } from "lucide-react";

const toolLabels: Record<string, string> = {
  handoff: "Handoff",
  generateYaml: "Generate YAML",
};

function formatToolName(name: string): string {
  if (toolLabels[name]) return toolLabels[name];
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

type ValidationFailure = {
  passed: false;
  errors: Array<{ field: string; message: string }>;
};

function isValidationFailure(o: unknown): o is ValidationFailure {
  if (typeof o !== "object" || o === null) return false;
  const obj = o as { passed?: unknown; errors?: unknown };
  return (
    obj.passed === false &&
    Array.isArray(obj.errors) &&
    obj.errors.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { field?: unknown }).field === "string" &&
        typeof (e as { message?: unknown }).message === "string"
    )
  );
}

/**
 * The AI SDK encodes input-validation failures into `errorText` like:
 *   "Invalid input for tool foo: Type validation failed: Value: {...}.
 *    Error message: [{...zod issues...}]"
 * Try to extract the embedded Zod issues array so we can render them as a
 * bullet list. Returns null when the text doesn't match the expected shape.
 */
function parseZodIssuesFromErrorText(
  errorText: string
): Array<{ path: string; message: string }> | null {
  const marker = "Error message: ";
  const idx = errorText.indexOf(marker);
  if (idx < 0) return null;
  const jsonPart = errorText.slice(idx + marker.length).trim();
  try {
    const issues = JSON.parse(jsonPart);
    if (!Array.isArray(issues)) return null;
    return issues
      .filter(
        (i): i is { path?: unknown[]; message?: unknown } =>
          !!i && typeof i === "object"
      )
      .map((i) => ({
        path:
          Array.isArray(i.path) && i.path.length > 0
            ? i.path.map((p) => String(p)).join(".")
            : "(root)",
        message: typeof i.message === "string" ? i.message : "Invalid value",
      }));
  } catch {
    return null;
  }
}

interface ToolResultProps {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export function ToolResult({ toolName, state, input, output, errorText }: ToolResultProps) {
  const [expanded, setExpanded] = useState(false);

  const isLoading = state === "input-streaming" || state === "input-available";
  const isThrownError = state === "output-error";
  const isDone = state === "output-available";
  const isFailedValidation = isDone && isValidationFailure(output);
  const isFailure = isThrownError || isFailedValidation;

  // Pre-parse Zod issues out of errorText so we can render them as a list
  // when the AI SDK rejected the tool input via schema validation.
  const zodIssues = errorText ? parseZodIssuesFromErrorText(errorText) : null;

  const label = formatToolName(toolName) + (isLoading ? "..." : "");

  return (
    <div className="my-1">
      <button
        onClick={() => {
          if (isDone || isThrownError) setExpanded((prev) => !prev);
        }}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition-colors ${
          isFailure
            ? "border-red-500/20 bg-red-500/5"
            : "border-white/10 bg-white/5 hover:bg-white/[0.08]"
        }`}
      >
        {isLoading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#e0a96e]" />
        ) : isFailure ? (
          <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
        ) : isDone ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-white/30" />
        )}

        <span className={`flex-1 text-xs ${isFailure ? "text-red-300" : "text-white/50"}`}>
          {label}
          {isFailedValidation && (
            <span className="ml-1 text-red-400/70">
              ({(output as ValidationFailure).errors.length} {(output as ValidationFailure).errors.length === 1 ? "error" : "errors"})
            </span>
          )}
          {isThrownError && zodIssues && zodIssues.length > 0 && (
            <span className="ml-1 text-red-400/70">
              ({zodIssues.length} {zodIssues.length === 1 ? "error" : "errors"})
            </span>
          )}
        </span>

        {(isDone || isThrownError) && (
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
          {isFailedValidation && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/30">
                Errors
              </div>
              <ul className="space-y-1">
                {(output as ValidationFailure).errors.map((err, i) => (
                  <li key={i} className="text-xs text-red-300/80">
                    <span className="font-mono text-red-400">{err.field}</span>
                    <span className="text-red-300/50">: </span>
                    {err.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isDone && !isFailedValidation && output != null && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/30">
                Output
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-white/50">
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
          {isThrownError && (errorText || output != null) && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/30">
                Error
              </div>
              {zodIssues && zodIssues.length > 0 ? (
                <ul className="space-y-1">
                  {zodIssues.map((issue, i) => (
                    <li key={i} className="text-xs text-red-300/80">
                      <span className="font-mono text-red-400">{issue.path}</span>
                      <span className="text-red-300/50">: </span>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap text-red-300/70">
                  {errorText
                    ? errorText
                    : typeof output === "object" && output && "errorText" in output
                      ? String((output as { errorText: string }).errorText)
                      : JSON.stringify(output, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
