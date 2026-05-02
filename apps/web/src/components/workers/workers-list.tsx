"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Plus } from "lucide-react";
import {
  createWorker,
  listWorkers,
  type CreateWorkerResult,
  type WorkerSummary,
} from "@/lib/actions/workers";
import { Button } from "@/components/ui/button";

const POLL_INTERVAL_MS = 2_000;

export function WorkersList({
  initialWorkers,
}: {
  initialWorkers: WorkerSummary[];
}) {
  const params = useParams<{ id?: string }>();
  const router = useRouter();
  const selectedId = params?.id;

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

  useEffect(() => {
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const liveCount = workers.filter((w) => w.isLive).length;

  return (
    <div className="relative z-10 flex h-full w-80 shrink-0 flex-col border-r border-white/10 bg-black/20 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
          Workers
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/30">
            {workers.length === 0
              ? "0 total"
              : `${liveCount} online · ${workers.length} total`}
          </span>
          <button
            onClick={() => setAddOpen(true)}
            className="flex h-5 w-5 items-center justify-center rounded text-white/50 transition-colors hover:bg-white/10 hover:text-white"
            title="Add worker"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
          {error}
          <button
            className="ml-2 underline"
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {workers.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-white/30">
            No workers yet
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workers.map((w) => {
              const isSelected = selectedId === w.id;
              return (
                <Link
                  key={w.id}
                  href={`/settings/workers/${w.id}`}
                  className={`group flex flex-col gap-1 rounded-lg px-3 py-2 transition-colors ${
                    isSelected
                      ? "bg-white/10 text-white"
                      : "text-white/70 hover:bg-white/5 hover:text-white/90"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <LiveDot isLive={w.isLive} />
                    <span className="flex-1 truncate text-xs">{w.name}</span>
                  </div>
                  <div className="flex items-center gap-2 pl-3.5">
                    <span className="text-[10px] uppercase tracking-wider text-white/40">
                      {w.mode}
                    </span>
                    <span className="text-[10px] text-white/30">
                      {w.lastSeenAt
                        ? formatRelative(w.lastSeenAt)
                        : "never seen"}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {addOpen && (
        <AddWorkerDialog
          onClose={() => setAddOpen(false)}
          onCreated={(res) => {
            setCreatedSecret(res);
            setAddOpen(false);
            refresh();
            router.push(`/settings/workers/${res.worker.id}`);
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

function LiveDot({ isLive }: { isLive: boolean }) {
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${
        isLive ? "bg-emerald-400" : "bg-white/30"
      }`}
    />
  );
}

function formatRelative(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
                <code>apps/agent-worker/.env</code> and run{" "}
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
              Online.
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
