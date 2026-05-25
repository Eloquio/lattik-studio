import { createHash } from "node:crypto";

/**
 * Verify that a `dag_runs.manifest_sha` still matches the YAML currently
 * in the corresponding `dags.yaml_raw`. Returns `{ ok: true }` when they
 * match (or when the run pre-dates manifest pinning and the recorded SHA
 * is null), `{ ok: false, expected, actual }` otherwise.
 *
 * Called from the task launch step. A mismatch means the YAML moved
 * between enqueue and execution (a PR merged in the meantime), so the
 * run's topology/parameters no longer match what the scheduler signed up
 * for — refuse to launch and let the user re-enqueue against the new
 * YAML if that's what they want.
 */
export function verifyManifestSha(
  currentYamlRaw: string,
  pinnedSha: string | null
): { ok: true } | { ok: false; expected: string; actual: string } {
  if (pinnedSha === null) return { ok: true };
  const actual = createHash("sha256").update(currentYamlRaw).digest("hex");
  if (actual === pinnedSha) return { ok: true };
  return { ok: false, expected: pinnedSha, actual };
}
