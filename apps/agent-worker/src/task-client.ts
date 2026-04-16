/**
 * HTTP client for the task queue API.
 * All agent interactions with the task queue go through this client.
 */

const API_BASE = process.env.TASK_API_URL;
const API_SECRET = process.env.TASK_AGENT_SECRET;

if (!API_BASE) {
  throw new Error("TASK_API_URL is required");
}
if (!API_SECRET) {
  throw new Error("TASK_AGENT_SECRET is required");
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_SECRET}`,
};

export interface Task {
  id: string;
  request_id: string;
  agent_id: string;
  description: string;
  done_criteria: string;
  status: string;
  claimed_by: string | null;
  result: unknown;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  stale_at: string | null;
  completed_at: string | null;
}

export async function claimTask(
  agentId: string,
  claimedBy: string
): Promise<Task | null> {
  const res = await fetch(`${API_BASE}/api/tasks/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agentId, claimedBy }),
  });

  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`Failed to claim task: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function completeTask(
  id: string,
  result?: unknown
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ result }),
  });
  if (!res.ok) {
    throw new Error(`Failed to complete task: ${res.status} ${res.statusText}`);
  }
}

export async function failTask(id: string, error: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/fail`, {
    method: "POST",
    headers,
    body: JSON.stringify({ error }),
  });
  if (!res.ok) {
    throw new Error(`Failed to fail task: ${res.status} ${res.statusText}`);
  }
}
