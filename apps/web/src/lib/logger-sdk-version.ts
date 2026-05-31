import type { ColumnSig } from "@/lib/logger-sdk-generator";

/**
 * Pure semver-derivation for logger SDK packages, split out from
 * `@/lib/github-packages` so it can be unit-tested without loading the
 * npm-publish / registry-fetch / tar dependencies. No I/O.
 *
 * The version a logger package gets on each publish is derived from the diff
 * between its current column schema and the schema embedded in the
 * last-published version (`lattikSchema` in package.json).
 */

type Bump = "major" | "minor" | "patch";

/** Order-independent equality of two column signatures. */
export function sigsEqual(a: ColumnSig[], b: ColumnSig[]): boolean {
  if (a.length !== b.length) return false;
  const byName = (xs: ColumnSig[]) =>
    [...xs].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const sa = byName(a);
  const sb = byName(b);
  return sa.every(
    (c, i) =>
      c.name === sb[i]!.name &&
      c.type === sb[i]!.type &&
      c.classification === sb[i]!.classification,
  );
}

/**
 * Classify a schema change: a removed/renamed/retyped column is breaking
 * (major), a purely additive change is minor, anything else is patch. Since
 * this only compares name+type, the patch case is reached when those match but
 * `sigsEqual` already found a difference — i.e. a classification-only change.
 * (description/tags aren't in the signature, so they never reach here.)
 */
export function diffBump(prev: ColumnSig[], next: ColumnSig[]): Bump {
  const prevByName = new Map(prev.map((c) => [c.name, c.type]));
  const nextByName = new Map(next.map((c) => [c.name, c.type]));

  for (const [name, type] of prevByName) {
    // A renamed column reads as old-removed + new-added; the removal alone
    // already forces major, which is the safe (breaking) call.
    if (!nextByName.has(name) || nextByName.get(name) !== type) return "major";
  }
  for (const name of nextByName.keys()) {
    if (!prevByName.has(name)) return "minor";
  }
  return "patch";
}

/**
 * Bump `prevVersion` according to the schema diff. Any prerelease/build
 * metadata on `prevVersion` (e.g. "1.2.3-rc.1") is intentionally discarded —
 * the regex matches only the leading x.y.z and the bump always yields a clean
 * release version (our published SDKs are only ever clean x.y.z). Falls back
 * to "1.0.0" if `prevVersion` has no parseable x.y.z prefix (defensive —
 * shouldn't happen for our own published packages).
 */
export function computeVersionBump(
  prev: ColumnSig[],
  next: ColumnSig[],
  prevVersion: string,
): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(prevVersion);
  if (!m) return "1.0.0";
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  switch (diffBump(prev, next)) {
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "patch":
      patch += 1;
      break;
  }
  return `${major}.${minor}.${patch}`;
}

export interface PublishDecision {
  action: "created" | "published" | "unchanged";
  version: string;
}

/**
 * Decide what to publish given the current published state:
 *   - no published version        → create at 1.0.0
 *   - schema unchanged vs latest  → no-op (unchanged)
 *   - otherwise                   → diff-derived version bump
 * If the latest version's schema is unknown (older package without an embedded
 * `lattikSchema`), we can't prove "unchanged", so we treat it as a change.
 */
export function decidePublishAction(input: {
  latestVersion: string | null;
  prevSchema: ColumnSig[] | null;
  nextSchema: ColumnSig[];
}): PublishDecision {
  if (input.latestVersion === null) {
    return { action: "created", version: "1.0.0" };
  }
  if (input.prevSchema && sigsEqual(input.prevSchema, input.nextSchema)) {
    return { action: "unchanged", version: input.latestVersion };
  }
  return {
    action: "published",
    version: computeVersionBump(
      input.prevSchema ?? [],
      input.nextSchema,
      input.latestVersion,
    ),
  };
}
