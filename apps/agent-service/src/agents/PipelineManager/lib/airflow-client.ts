/**
 * Typed HTTP client for the Airflow 3.x REST API.
 *
 * Scoped to the Pipeline Manager extension — not a shared utility.
 * All methods filter to Lattik-managed DAGs (tagged "lattik") unless
 * explicitly overridden.
 */

const AIRFLOW_API_URL =
  process.env.AIRFLOW_API_URL ?? "http://localhost:8088";

const BASE = `${AIRFLOW_API_URL}/api/v2`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AirflowDag {
  dag_id: string;
  dag_display_name: string;
  description: string | null;
  is_paused: boolean;
  // Airflow 3.x's `GET /dags` list response no longer surfaces these
  // three fields — only `GET /dags/{id}` does. They're optional here so
  // list-derived shapes can be coerced from the new fields below.
  is_active?: boolean;
  schedule_interval?: { value: string } | string | null;
  next_dagrun?: string | null;
  // Airflow 3.x replacements available on the list response.
  is_stale?: boolean;
  timetable_summary?: string | null;
  tags: Array<{ name: string }>;
  last_parsed_time: string | null;
  owners?: string[];
}

export interface AirflowDagRun {
  dag_run_id: string;
  dag_id: string;
  logical_date: string;
  start_date: string | null;
  end_date: string | null;
  state: "queued" | "running" | "success" | "failed";
  conf: Record<string, unknown>;
  note: string | null;
}

export interface AirflowTaskInstance {
  task_id: string;
  dag_run_id: string;
  state:
    | "success"
    | "running"
    | "failed"
    | "upstream_failed"
    | "skipped"
    | "up_for_retry"
    | "queued"
    | "scheduled"
    | "deferred"
    | "removed"
    | null;
  start_date: string | null;
  end_date: string | null;
  duration: number | null;
  try_number: number;
  max_tries: number;
  operator: string | null;
}

export interface AirflowDagDetail extends AirflowDag {
  file_token: string;
  has_task_concurrency_limits: boolean;
  max_active_runs: number;
  max_active_tasks: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function airflowFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Airflow API ${init?.method ?? "GET"} ${path} returned ${res.status}: ${body}`
    );
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// DAGs
// ---------------------------------------------------------------------------

export async function listDags(opts?: {
  tags?: string[];
  limit?: number;
  offset?: number;
}): Promise<{ dags: AirflowDag[]; total_entries: number }> {
  const params = new URLSearchParams();
  if (opts?.tags) {
    for (const tag of opts.tags) params.append("tags", tag);
  }
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return airflowFetch(`/dags${qs ? `?${qs}` : ""}`);
}

export async function getDag(dagId: string): Promise<AirflowDagDetail> {
  return airflowFetch(`/dags/${encodeURIComponent(dagId)}`);
}

export async function patchDag(
  dagId: string,
  patch: { is_paused?: boolean }
): Promise<AirflowDagDetail> {
  return airflowFetch(`/dags/${encodeURIComponent(dagId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---------------------------------------------------------------------------
// DAG Runs
// ---------------------------------------------------------------------------

export async function listDagRuns(
  dagId: string,
  opts?: { limit?: number; offset?: number; orderBy?: string }
): Promise<{ dag_runs: AirflowDagRun[]; total_entries: number }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.orderBy) params.set("order_by", opts.orderBy);
  const qs = params.toString();
  return airflowFetch(
    `/dags/${encodeURIComponent(dagId)}/dagRuns${qs ? `?${qs}` : ""}`
  );
}

export async function triggerDagRun(
  dagId: string,
  opts?: { logicalDate?: string; conf?: Record<string, unknown> }
): Promise<AirflowDagRun> {
  return airflowFetch(
    `/dags/${encodeURIComponent(dagId)}/dagRuns`,
    {
      method: "POST",
      body: JSON.stringify({
        logical_date: opts?.logicalDate,
        conf: opts?.conf ?? {},
      }),
    }
  );
}

// ---------------------------------------------------------------------------
// Task Instances
// ---------------------------------------------------------------------------

export async function listTaskInstances(
  dagId: string,
  dagRunId: string,
  opts?: { limit?: number }
): Promise<{
  task_instances: AirflowTaskInstance[];
  total_entries: number;
}> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return airflowFetch(
    `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(dagRunId)}/taskInstances${qs ? `?${qs}` : ""}`
  );
}

export async function getTaskLogs(
  dagId: string,
  dagRunId: string,
  taskId: string,
  opts?: { tryNumber?: number }
): Promise<string> {
  const tryNum = opts?.tryNumber ?? 1;
  const url = `${BASE}/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(dagRunId)}/taskInstances/${encodeURIComponent(taskId)}/logs/${tryNum}`;
  const res = await fetch(url, {
    headers: { Accept: "text/plain" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Airflow API GET task logs returned ${res.status}: ${body}`
    );
  }
  return res.text();
}

export async function clearTaskInstance(
  dagId: string,
  dagRunId: string,
  taskId: string
): Promise<AirflowTaskInstance> {
  return airflowFetch(
    `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(dagRunId)}/taskInstances/${encodeURIComponent(taskId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ dry_run: false, new_state: "cleared" }),
    }
  );
}
