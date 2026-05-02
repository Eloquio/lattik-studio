import { Bot, User } from "lucide-react";
import type { RequestStatus, requests, runs } from "@/db/schema";
import { CollapsibleContext } from "./collapsible-context";
import { RunCard } from "./run-card";

type RequestRow = typeof requests.$inferSelect;
type RunRow = typeof runs.$inferSelect;

const STATUS_COLOR: Record<RequestStatus, string> = {
  pending: "bg-white/10 text-white/60",
  planning: "bg-sky-400/15 text-sky-300",
  awaiting_approval: "bg-amber-400/15 text-amber-300",
  approved: "bg-emerald-400/10 text-emerald-300/80",
  done: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
};

function formatDateTime(date: Date | string | null | undefined) {
  if (!date) return "—";
  return new Date(date).toLocaleString();
}

export function RequestDetail({
  request,
  runs,
}: {
  request: RequestRow;
  runs: RunRow[];
}) {
  const SourceIcon = request.source === "webhook" ? Bot : User;
  const messages = (request.messages ?? []) as {
    role: "planner" | "human";
    content: string;
    timestamp: string;
  }[];

  const totalIn = runs.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
  const totalOut = runs.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
  const totalTools = runs.reduce((n, r) => n + (r.toolCallCount ?? 0), 0);
  const runsLabel = runs.length === 0
    ? "Runs (0)"
    : totalIn + totalOut === 0
    ? `Runs (${runs.length})`
    : `Runs (${runs.length}) · ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out tokens${totalTools > 0 ? ` · ${totalTools} tool ${totalTools === 1 ? "call" : "calls"}` : ""}`;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-6 py-4">
        <SourceIcon className="h-4 w-4 text-white/50" />
        <h1 className="flex-1 truncate text-sm font-semibold text-white/90">
          {request.description}
        </h1>
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${STATUS_COLOR[request.status]}`}
        >
          {request.status.replace(/_/g, " ")}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
          <Section title="Overview">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <Row label="ID" value={<code className="font-mono text-[11px] text-white/70">{request.id}</code>} />
              <Row label="Source" value={request.source} />
              <Row label="Skill" value={request.skillId ?? "—"} />
              <Row label="Created" value={formatDateTime(request.createdAt)} />
              <Row label="Updated" value={formatDateTime(request.updatedAt)} />
            </dl>
          </Section>

          {request.context !== null && request.context !== undefined && (
            <CollapsibleContext context={request.context} />
          )}

          <Section title={runsLabel}>
            {runs.length === 0 ? (
              <p className="text-xs text-white/40">No runs created yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {runs.map((run) => (
                  <RunCard key={run.id} run={run} />
                ))}
              </div>
            )}
          </Section>

          <Section title={`Activity (${messages.length})`}>
            {messages.length === 0 ? (
              <p className="text-xs text-white/40">No activity yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {messages.map((msg, idx) => {
                  const isSystem = msg.role === "planner";
                  const label = isSystem ? "System" : "You";
                  const isError = isSystem && msg.content.startsWith("Error:");
                  return (
                    <div
                      key={idx}
                      className={`rounded-md border p-3 ${
                        isError
                          ? "border-red-400/30 bg-red-500/5"
                          : "border-white/10 bg-white/[0.02]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider ${
                            isError
                              ? "text-red-300"
                              : isSystem
                              ? "text-white/50"
                              : "text-sky-300"
                          }`}
                        >
                          {label}
                        </span>
                        <span className="text-[10px] text-white/30">
                          {formatDateTime(msg.timestamp)}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-xs text-white/80">
                        {msg.content}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/40">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-white/40">{label}</dt>
      <dd className="text-white/80">{value}</dd>
    </>
  );
}
