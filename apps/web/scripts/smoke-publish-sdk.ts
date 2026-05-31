/**
 * Manual smoke test for the GitHub Packages logger-SDK publish path.
 *
 * It drives the REAL `publishLoggerSdk` code path against the live registry to
 * validate the two things unit tests cannot:
 *   1. a classic PAT can CREATE a new org-scoped package, and
 *   2. the `lattikSchema` round-trip works on GitHub Packages specifically
 *      (publish → read it back from the published tarball → detect "unchanged").
 *
 * ⚠ This publishes a REAL, throwaway package to your org. Delete it afterward:
 *   https://github.com/orgs/<org>/packages → `logger-smoketest-delete-me`
 *   → Package settings → Delete this package.
 *
 * Run (token comes from the machine-user PAT; nothing is hardcoded):
 *   GITHUB_PACKAGES_PUBLISH_ENABLED=true \
 *   GITHUB_PACKAGES_TOKEN=YOUR_PAT \
 *   GITHUB_PACKAGES_SCOPE=@eloquio \
 *   pnpm --filter web exec -- tsx scripts/smoke-publish-sdk.ts
 */
import {
  publishLoggerSdk,
  type PublishLoggerSdkResult,
} from "@/lib/github-packages";
import type { LoggerTable } from "@/extensions/data-architect/schema";

const TABLE = "smoketest.delete_me";

function table(columns: LoggerTable["columns"]): LoggerTable {
  return {
    name: TABLE,
    description: "Throwaway smoke-test package — safe to delete.",
    retention: "30d",
    dedup_window: "1h",
    columns,
  };
}

type ExpectedAction = PublishLoggerSdkResult["action"] | "any";

async function step(
  label: string,
  expect: ExpectedAction,
  t: LoggerTable,
): Promise<PublishLoggerSdkResult> {
  const r = await publishLoggerSdk(t);
  const ok = expect === "any" || r.action === expect;
  console.log(
    `${ok ? "✓" : "✗"} ${label}\n    → action=${r.action} version=${r.version} package=${r.packageName}`,
  );
  if (!ok) console.log(`    (expected action=${expect})`);
  return r;
}

async function main(): Promise<void> {
  if (process.env.GITHUB_PACKAGES_PUBLISH_ENABLED !== "true") {
    console.error(
      "Set GITHUB_PACKAGES_PUBLISH_ENABLED=true and GITHUB_PACKAGES_TOKEN — otherwise this is a no-op. Aborting.",
    );
    process.exit(1);
  }
  console.log(
    "Publishing a throwaway package to validate the real publish path.\n",
  );

  const baseCols: LoggerTable["columns"] = [
    { name: "a", type: "string" },
    { name: "b", type: "int64" },
  ];

  // 1) First publish: created on a fresh package, published on re-runs.
  const r1 = await step(
    "1) publish (creates the org-scoped package the first time)",
    "any",
    table(baseCols),
  );
  // 2) Same schema again → MUST be "unchanged". This is the real proof that the
  //    published lattikSchema was read back correctly from the tarball.
  const r2 = await step(
    "2) re-run, identical schema → must be UNCHANGED (proves round-trip)",
    "unchanged",
    table(baseCols),
  );
  // 3) Add a column → MUST be a published minor bump.
  const r3 = await step(
    "3) add a column → must be a published (minor) bump",
    "published",
    table([...baseCols, { name: "c", type: "boolean" }]),
  );

  const roundTripOk = r2.action === "unchanged";
  console.log(
    `\nSummary: first=${r1.action}@${r1.version}, round-trip=${roundTripOk ? "WORKS" : "FAILED"}, bump ${r1.version} → ${r3.version}`,
  );
  console.log(`Package page: ${r3.packageUrl}`);
  if (!roundTripOk) {
    console.log(
      "\n⚠ Step 2 was not 'unchanged'. Either GitHub Packages didn't return the published tarball as expected (the schema round-trip needs another approach), or there's brief propagation lag — re-run once; if it persists, investigate fetchPublishedState.",
    );
  }
  console.log("\nRemember to delete the throwaway package from the org Packages tab.");
}

main().catch((err: unknown) => {
  const e = err as { statusCode?: number; message?: string };
  console.error(
    `\n✗ Smoke test failed${e.statusCode ? ` (HTTP ${e.statusCode})` : ""}: ${e.message ?? String(err)}`,
  );
  if (e.statusCode === 401) {
    console.error("  → 401: token invalid / not recognized by the registry.");
  }
  if (e.statusCode === 403) {
    console.error(
      "  → 403: token lacks write:packages, or the machine user isn't an org member / isn't allowed to create packages.",
    );
  }
  process.exit(1);
});
