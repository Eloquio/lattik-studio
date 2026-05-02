"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StepKind, steps as stepsTable } from "@/db/schema";

type StepRow = typeof stepsTable.$inferSelect;

export function RunFlowchart({
  runId,
  isTerminal,
}: {
  runId: string;
  isTerminal: boolean;
}) {
  const [stepRows, setStepRows] = useState<StepRow[]>([]);
  const [streamState, setStreamState] = useState<"connecting" | "open" | "done" | "error">(
    "connecting",
  );

  useEffect(() => {
    if (isTerminal) {
      // Run is already done — just fetch once and skip the stream.
      fetch(`/api/runs/${runId}/steps`)
        .then((r) => r.json())
        .then((rows: StepRow[]) => {
          setStepRows(rows);
          setStreamState("done");
        })
        .catch(() => setStreamState("error"));
      return;
    }

    const es = new EventSource(`/api/runs/${runId}/steps/stream`);
    es.addEventListener("snapshot", (e) => {
      setStreamState("open");
      try {
        setStepRows(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore
      }
    });
    es.addEventListener("step", (e) => {
      try {
        const row = JSON.parse((e as MessageEvent).data) as StepRow;
        setStepRows((prev) => {
          if (prev.some((s) => s.sequence === row.sequence)) return prev;
          return [...prev, row].sort((a, b) => a.sequence - b.sequence);
        });
      } catch {
        // ignore
      }
    });
    es.addEventListener("done", () => {
      setStreamState("done");
      es.close();
    });
    es.onerror = () => {
      setStreamState("error");
      es.close();
    };
    return () => es.close();
  }, [runId, isTerminal]);

  if (stepRows.length === 0) {
    return (
      <p className="text-[11px] text-white/30">
        {streamState === "connecting" ? "Connecting…" : "No steps yet."}
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-1">
      {stepRows.map((row) => (
        <StepNode key={row.id} step={row} />
      ))}
      {streamState === "open" && <StreamingIndicator />}
    </ol>
  );
}

function StreamingIndicator() {
  return (
    <li className="flex items-center gap-2 pl-3 text-[11px] text-white/40">
      <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
      Running…
    </li>
  );
}

function StepNode({ step }: { step: StepRow }) {
  const kind = step.kind as StepKind;
  switch (kind) {
    case "text":
      return <TextNode payload={step.payload} sequence={step.sequence} />;
    case "reasoning":
      return <ReasoningNode payload={step.payload} sequence={step.sequence} />;
    case "tool_call":
      return <ToolCallNode payload={step.payload} sequence={step.sequence} />;
    case "tool_result":
      return <ToolResultNode payload={step.payload} sequence={step.sequence} />;
    case "finish":
      return <FinishNode payload={step.payload} sequence={step.sequence} />;
    case "error":
      return <ErrorNode payload={step.payload} sequence={step.sequence} />;
  }
}

function NodeShell({
  badge,
  badgeClass,
  sequence,
  children,
}: {
  badge: string;
  badgeClass: string;
  sequence: number;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span className="mt-0.5 w-6 shrink-0 font-mono text-[10px] text-white/30">
        {sequence}
      </span>
      <span
        className={`mt-0.5 inline-flex w-16 shrink-0 items-center justify-center rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${badgeClass}`}
      >
        {badge}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </li>
  );
}

function TextNode({ payload, sequence }: { payload: unknown; sequence: number }) {
  const p = payload as { text?: string };
  return (
    <NodeShell badge="text" badgeClass="bg-white/10 text-white/70" sequence={sequence}>
      <MarkdownBlock text={p.text ?? ""} className="text-white/80" />
    </NodeShell>
  );
}

function ReasoningNode({ payload, sequence }: { payload: unknown; sequence: number }) {
  const p = payload as { text?: string };
  return (
    <NodeShell
      badge="thinking"
      badgeClass="bg-violet-400/15 text-violet-200"
      sequence={sequence}
    >
      <MarkdownBlock text={p.text ?? ""} className="italic text-white/60" />
    </NodeShell>
  );
}

function JsonTrigger({
  label,
  value,
  open,
  onToggle,
}: {
  label: string;
  value: unknown;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="group flex min-w-0 items-center gap-1 text-[10px] text-white/40 transition-colors hover:text-white/70"
    >
      {open ? (
        <ChevronDown className="h-3 w-3 shrink-0" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0" />
      )}
      <span className="font-medium uppercase tracking-wider">{label}</span>
      <span className="truncate font-mono text-white/30 group-hover:text-white/50">
        {summarizeJson(value)}
      </span>
    </button>
  );
}

function JsonPanel({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 w-full whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 p-1.5 text-[10px] text-white/60">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// One-line peek at a JSON value — keys for objects, count for arrays, raw
// for primitives. Trim aggressively so the closed disclosure stays on one
// line even with messy payloads.
function summarizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    const s = value.length > 40 ? value.slice(0, 40) + "…" : value;
    return `"${s}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return "{ }";
    const shown = keys.slice(0, 3).join(", ");
    const more = keys.length > 3 ? `, +${keys.length - 3}` : "";
    return `{ ${shown}${more} }`;
  }
  return String(value);
}

function MarkdownBlock({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={`prose-step ${className ?? ""}`}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="my-1 first:mt-0 last:mb-0 whitespace-pre-wrap break-words">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="my-1 first:mt-0 last:mb-0 ml-4 list-disc space-y-0.5">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1 first:mt-0 last:mb-0 ml-4 list-decimal space-y-0.5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-white/90">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children }) => (
            <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[10px] text-white/80">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-1 overflow-x-auto rounded border border-white/10 bg-black/30 p-2 text-[10px]">
              {children}
            </pre>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-sky-300 underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function ToolCallNode({ payload, sequence }: { payload: unknown; sequence: number }) {
  const p = payload as { toolName?: string; input?: unknown };
  const [open, setOpen] = useState(false);
  return (
    <NodeShell
      badge="tool"
      badgeClass="bg-sky-400/20 text-sky-200"
      sequence={sequence}
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-sky-200">{p.toolName}</span>
        {p.input !== undefined && (
          <JsonTrigger
            label="input"
            value={p.input}
            open={open}
            onToggle={() => setOpen((v) => !v)}
          />
        )}
      </div>
      {open && p.input !== undefined && <JsonPanel value={p.input} />}
    </NodeShell>
  );
}

function ToolResultNode({ payload, sequence }: { payload: unknown; sequence: number }) {
  const p = payload as { toolName?: string; output?: unknown };
  const [open, setOpen] = useState(false);
  const failed = isFailedToolResult(p.output);
  const stub =
    p.output !== null &&
    typeof p.output === "object" &&
    (p.output as { not_implemented?: unknown }).not_implemented === true;

  const badgeClass = failed
    ? "bg-red-500/20 text-red-200"
    : "bg-emerald-400/15 text-emerald-200";
  const labelClass = failed ? "text-red-200/80" : "text-emerald-200/80";
  const badge = failed ? "failed" : "result";

  return (
    <NodeShell badge={badge} badgeClass={badgeClass} sequence={sequence}>
      <div className="flex items-center gap-3">
        <span className={`font-mono text-[11px] ${labelClass}`}>
          {p.toolName}
        </span>
        {stub && (
          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-200">
            not yet implemented
          </span>
        )}
        {p.output !== undefined && (
          <JsonTrigger
            label="output"
            value={p.output}
            open={open}
            onToggle={() => setOpen((v) => !v)}
          />
        )}
      </div>
      {open && p.output !== undefined && <JsonPanel value={p.output} />}
    </NodeShell>
  );
}

// Tool outputs follow `{ ok: boolean, error?: string, ... }`. `ok: false` is a
// failure regardless of why — `not_implemented: true` is just a reason. The
// stub-tool case still renders red, with an inline "not yet implemented" tag
// so the human can tell it apart from a runtime crash without it being
// reclassified as something other than failed.
function isFailedToolResult(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  const o = output as { ok?: unknown; error?: unknown };
  if (o.ok === false) return true;
  if (typeof o.error === "string" && o.error.length > 0) return true;
  return false;
}

function FinishNode({ payload, sequence }: { payload: unknown; sequence: number }) {
  const p = payload as { finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
  return (
    <NodeShell
      badge="finish"
      badgeClass="bg-white/5 text-white/40"
      sequence={sequence}
    >
      <p className="text-white/40">
        {p.finishReason ?? "—"}
        {p.usage &&
          ` · ${p.usage.inputTokens ?? 0} in / ${p.usage.outputTokens ?? 0} out`}
      </p>
    </NodeShell>
  );
}

function ErrorNode({ payload, sequence }: { payload: unknown; sequence: number }) {
  const p = payload as { message?: string };
  return (
    <NodeShell
      badge="error"
      badgeClass="bg-red-500/20 text-red-200"
      sequence={sequence}
    >
      <p className="text-red-300/80">{p.message ?? JSON.stringify(payload)}</p>
    </NodeShell>
  );
}
