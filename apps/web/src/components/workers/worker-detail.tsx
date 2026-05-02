"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  getWorker,
  renameWorker,
  revokeWorker,
  type WorkerSummary,
} from "@/lib/actions/workers";
import { Button } from "@/components/ui/button";

const POLL_INTERVAL_MS = 2_000;

function formatDateTime(date: Date | string | null | undefined) {
  if (!date) return "—";
  return new Date(date).toLocaleString();
}

export function WorkerDetail({
  initialWorker,
}: {
  initialWorker: WorkerSummary;
}) {
  const router = useRouter();
  const [worker, setWorker] = useState(initialWorker);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialWorker.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setWorker(initialWorker);
    setDraft(initialWorker.name);
  }, [initialWorker]);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const fresh = await getWorker(worker.id);
        if (fresh) setWorker(fresh);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [worker.id]);

  const commitRename = () => {
    if (draft === worker.name || !draft.trim()) {
      setEditing(false);
      setDraft(worker.name);
      return;
    }
    startTransition(async () => {
      try {
        const updated = await renameWorker({ id: worker.id, name: draft.trim() });
        setWorker(updated);
        setEditing(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const onRevoke = () => {
    if (
      !confirm(
        `Revoke worker "${worker.name}"?${
          worker.mode === "cluster" ? " This tears down the pod." : ""
        }`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await revokeWorker(worker.id);
        router.push("/settings/workers");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-6 py-4">
        <span
          className={`size-2 rounded-full ${
            worker.isLive ? "bg-emerald-400" : "bg-white/30"
          }`}
        />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(worker.name);
                setEditing(false);
              }
            }}
            className="flex-1 rounded border border-white/20 bg-black/30 px-2 py-1 text-sm text-white/90 outline-none focus:border-white/40"
          />
        ) : (
          <button
            className="flex-1 truncate text-left text-sm font-semibold text-white/90 hover:text-white"
            onClick={() => setEditing(true)}
            title="Click to rename"
          >
            {worker.name}
          </button>
        )}
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
            worker.isLive
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-white/10 text-white/60"
          }`}
        >
          {worker.isLive ? "Online" : worker.lastSeenAt ? "Offline" : "Starting"}
        </span>
      </div>

      {error && (
        <div className="border-b border-red-400/30 bg-red-500/10 px-6 py-2 text-xs text-red-200">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
          <Section title="Overview">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <Row
                label="ID"
                value={
                  <code className="font-mono text-[11px] text-white/70">
                    {worker.id}
                  </code>
                }
              />
              <Row label="Mode" value={worker.mode} />
              <Row
                label="Last seen"
                value={formatDateTime(worker.lastSeenAt)}
              />
              <Row label="Created" value={formatDateTime(worker.createdAt)} />
              <Row label="Updated" value={formatDateTime(worker.updatedAt)} />
            </dl>
          </Section>

          <Section title="Actions">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={onRevoke}
                disabled={pending}
                className="border-red-500/40 bg-red-500/20 text-red-100 hover:bg-red-500/30 focus-visible:ring-red-500/40"
              >
                Revoke
              </Button>
              <span className="text-[11px] text-white/40">
                {worker.mode === "cluster"
                  ? "Deletes the Deployment + Secret in the workers namespace."
                  : "Deletes the worker row. The host process will start failing auth."}
              </span>
            </div>
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
