/**
 * Context object passed into every task function inside the Vercel Sandbox.
 *
 * The host serializes this as JSON and ships it via the `O2FLOW_CTX` env
 * var; the sandbox runner parses it and invokes
 * `bundle[fnName](taskRunContext)`. Keep the surface minimal — task
 * authors who need more should pull from their own infra, not bloat this
 * type.
 */
export interface TaskRunContext {
  dagId: string;
  branch: "prod" | `pr-${number}`;
  isPrTest: boolean;
  prNumber: number | null;
  dagRunId: string;
  taskId: string;
  /** ISO 8601, e.g. "2026-05-10T00:00:00.000Z". */
  logicalDatetime: string;
  /** SHA of the bundle.js this run is pinned to. */
  bundleSha: string;
  /** 1-indexed; retries not wired yet so always 1 today. */
  attempt: number;
}
