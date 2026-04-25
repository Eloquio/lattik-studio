/**
 * Done-check executor.
 *
 * Each `done[]` entry in a SKILL.md frontmatter is a programmatic
 * verification step the runtime runs after `finishSkill`. v0.1 supports
 * `http`. The other discriminants in DoneCheck (sql, s3_object_exists,
 * shell) are deferred until a real skill needs them.
 *
 * Returns the first failure or null when everything passes.
 */

import type { DoneCheck } from "@eloquio/lattik-skills";

export interface DoneCheckFailure {
  index: number;
  kind: DoneCheck["kind"];
  reason: string;
}

export async function runDoneChecks(
  checks: DoneCheck[],
): Promise<DoneCheckFailure | null> {
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    const reason = await runOne(check);
    if (reason !== null) {
      return { index: i, kind: check.kind, reason };
    }
  }
  return null;
}

async function runOne(check: DoneCheck): Promise<string | null> {
  switch (check.kind) {
    case "http":
      return runHttp(check);
    default:
      return `done check kind "${check.kind}" not implemented in this runtime`;
  }
}

async function runHttp(
  check: Extract<DoneCheck, { kind: "http" }>,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(check.url, { method: check.method ?? "GET" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${check.method ?? "GET"} ${check.url} threw: ${msg}`;
  }
  if (
    check.expect_status !== undefined &&
    res.status !== check.expect_status
  ) {
    return `${check.method ?? "GET"} ${check.url} → ${res.status} (expected ${check.expect_status})`;
  }
  // No expect_status: any 2xx is success.
  if (check.expect_status === undefined && (res.status < 200 || res.status >= 300)) {
    return `${check.method ?? "GET"} ${check.url} → ${res.status} (expected 2xx)`;
  }
  return null;
}
