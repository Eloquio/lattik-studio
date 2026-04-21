"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  createWorker,
  listWorkers,
  renameWorker,
  revokeWorker,
  type CreateWorkerResult,
  type WorkerSummary,
} from "@/lib/actions/workers";
import { Button } from "@/components/ui/button";

// Poll for fresh liveness every 2s. Matches the plan — last_seen_at is the
// only signal, no k8s API watch.
const POLL_INTERVAL_MS = 2_000;

export function WorkersClient({
  initialWorkers,
}: {
  initialWorkers: WorkerSummary[];
}) {
  const [workers, setWorkers] = useState(initialWorkers);
  const [addOpen, setAddOpen] = useState(false);
  const [createdSecret, setCreatedSecret] =
    useState<CreateWorkerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listWorkers();
      setWorkers(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll for liveness updates while the page is open.
  useEffect(() => {
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 text-white/90">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/60">
          {workers.length === 0
            ? "No workers yet. Add one to start claiming tasks."
            : `${workers.filter((w) => w.isLive).length} online · ${workers.length} total`}
        </p>
        <Button
          onClick={() => setAddOpen(true)}
          variant="default"
          size="sm"
        >
          Add Worker
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
          <button
            className="ml-2 underline"
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </div>
      )}

      {workers.length > 0 && (
        <WorkerTable
          workers={workers}
          onChanged={refresh}
          onError={setError}
        />
      )}

      {addOpen && (
        <AddWorkerDialog
          onClose={() => setAddOpen(false)}
          onCreated={(res) => {
            setCreatedSecret(res);
            setAddOpen(false);
            refresh();
          }}
          onError={setError}
        />
      )}

      {createdSecret && (
        <CredentialsDialog
          result={createdSecret}
          onClose={() => setCreatedSecret(null)}
        />
      )}
    </div>
  );
}

function WorkerTable({
  workers,
  onChanged,
  onError,
}: {
  workers: WorkerSummary[];
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/50">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Mode</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Last seen</th>
            <th className="px-4 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {workers.map((w) => (
            <WorkerRow
              key={w.id}
              worker={w}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerRow({
  worker,
  onChanged,
  onError,
}: {
  worker: WorkerSummary;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(worker.name);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setDraft(worker.name);
  }, [worker.name]);

  const commit = () => {
    if (draft === worker.name || !draft.trim()) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      try {
        await renameWorker({ id: worker.id, name: draft });
        setEditing(false);
        onChanged();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const onRevoke = () => {
    if (!confirm(`Revoke worker "${worker.name}"? This tears down the pod.`)) {
      return;
    }
    startTransition(async () => {
      try {
        await revokeWorker(worker.id);
        onChanged();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <tr className="text-white/80">
      <td className="px-4 py-2">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(worker.name);
                setEditing(false);
              }
            }}
            className="w-full rounded border border-white/20 bg-black/30 px-2 py-1 text-sm outline-none focus:border-white/40"
          />
        ) : (
          <button
            className="text-left hover:text-white"
            onClick={() => setEditing(true)}
            title="Click to rename"
          >
            {worker.name}
          </button>
        )}
        <div className="font-mono text-[10px] text-white/30">{worker.id}</div>
      </td>
      <td className="px-4 py-2 text-xs uppercase tracking-wide text-white/50">
        {worker.mode}
      </td>
      <td className="px-4 py-2">
        <LivePill isLive={worker.isLive} lastSeenAt={worker.lastSeenAt} />
      </td>
      <td className="px-4 py-2 text-xs text-white/60">
        {worker.lastSeenAt
          ? formatRelative(worker.lastSeenAt)
          : "never"}
      </td>
      <td className="px-4 py-2 text-right">
        <Button
          variant="destructive"
          size="xs"
          onClick={onRevoke}
          disabled={pending}
        >
          Revoke
        </Button>
      </td>
    </tr>
  );
}

function LivePill({
  isLive,
  lastSeenAt,
}: {
  isLive: boolean;
  lastSeenAt: Date | null;
}) {
  if (isLive) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-200">
        <span className="size-1.5 rounded-full bg-emerald-400" />
        Online
      </span>
    );
  }
  const label = lastSeenAt ? "Offline" : "Starting";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/50">
      <span className="size-1.5 rounded-full bg-white/40" />
      {label}
    </span>
  );
}

function AddWorkerDialog({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (res: CreateWorkerResult) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"cluster" | "host">("cluster");
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    startTransition(async () => {
      try {
        const res = await createWorker({ name: name.trim(), mode });
        onCreated(res);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
        onClose();
      }
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className="rounded-lg border border-white/10 bg-neutral-900/95 p-6 text-white backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      onClose={onClose}
    >
      <form onSubmit={submit} className="w-96 space-y-4">
        <h2 className="text-base font-semibold">Add Worker</h2>
        <label className="block space-y-1 text-sm">
          <span className="text-white/70">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Mini in the office"
            className="w-full rounded border border-white/20 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-white/50"
          />
        </label>
        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 text-white/70">Mode</legend>
          <label className="flex gap-2 rounded border border-white/10 p-2 hover:bg-white/5">
            <input
              type="radio"
              name="mode"
              value="cluster"
              checked={mode === "cluster"}
              onChange={() => setMode("cluster")}
            />
            <div>
              <div>Deploy to cluster</div>
              <div className="text-xs text-white/50">
                Studio applies a Deployment in the kind <code>workers</code> namespace.
                No manual pasting of creds.
              </div>
            </div>
          </label>
          <label className="flex gap-2 rounded border border-white/10 p-2 hover:bg-white/5">
            <input
              type="radio"
              name="mode"
              value="host"
              checked={mode === "host"}
              onChange={() => setMode("host")}
            />
            <div>
              <div>Run on host</div>
              <div className="text-xs text-white/50">
                Studio shows the secret once; paste into{" "}
                <code>apps/agent-worker/.env</code> and run
                {" "}
                <code>pnpm --filter agent-worker dev</code>.
              </div>
            </div>
          </label>
        </fieldset>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => dialogRef.current?.close()}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="default" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

function CredentialsDialog({
  result,
  onClose,
}: {
  result: CreateWorkerResult;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const copyEnv = async () => {
    await navigator.clipboard.writeText(result.envBlock);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <dialog
      ref={dialogRef}
      className="rounded-lg border border-white/10 bg-neutral-900/95 p-6 text-white backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      onClose={onClose}
    >
      <div className="w-[36rem] space-y-4">
        <h2 className="text-base font-semibold">
          Worker created: {result.worker.name}
        </h2>
        {result.secret ? (
          <>
            <p className="text-xs text-amber-200">
              Copy the env block below and paste it into{" "}
              <code>apps/agent-worker/.env</code>. The secret is shown
              once — closing this dialog loses it.
            </p>
            <pre className="max-h-60 overflow-auto rounded border border-white/10 bg-black/60 p-3 text-xs">
              {result.envBlock}
            </pre>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={copyEnv}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => dialogRef.current?.close()}
              >
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-white/60">
              Deployment applied. The pod will poll within ~5s and flip to
              Online in the table.
            </p>
            <div className="flex justify-end">
              <Button
                variant="default"
                size="sm"
                onClick={() => dialogRef.current?.close()}
              >
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

function formatRelative(date: Date): string {
  const ms = Date.now() - date.getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
