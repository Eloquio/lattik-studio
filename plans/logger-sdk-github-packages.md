# Plan: Publish Logger SDKs as per-table npm packages on GitHub Packages

**Status:** proposed · **Date:** 2026-05-31 · **Owner:** Thomas

## Goal

Replace the current "upload one self-contained `.ts` file per logger table to S3" SDK step with **one published, versioned npm package per logger table** on **GitHub Packages** (`@eloquio/logger-<table>`), so consuming projects can `pnpm add` a typed Firehose client instead of copy-pasting a file. Publishing stays a deterministic step inside the existing Vercel post-merge workflow — no dedicated repo, no GitHub Actions, no sandbox, no LLM.

This is the conclusion of a multi-turn design discussion; the auth constraints behind it are recorded in memory (`logger-sdk-github-packages`). Read that for the *why* of the credential choice.

## Decisions already made (recap)

- **Granularity:** one package per logger table (independent versioning / blast radius), not a monorepo with subpath exports.
- **Channel:** GitHub Packages, internal visibility. Audience is internal-only; dozens of tables expected.
- **Where publish runs:** the existing deterministic `"use step"` in [post-pipeline-pr-merge.ts](../apps/web/src/workflows/post-pipeline-pr-merge.ts) (a Vercel Function, Node runtime).
- **How:** generate package files in-process → pack a tarball with `tar` → publish with `libnpmpublish`.
- **Credential:** a long-lived **classic PAT** with `write:packages`, owned by a **dedicated machine user** in the Eloquio org. (App installation tokens are rejected by the GH Packages npm registry; `GITHUB_TOKEN` is Actions-only and can't create new org-scoped packages; fine-grained is officially unsupported for npm. Classic is the only guaranteed path and isn't being sunset — the Dec 2025 sunset was npmjs.com tokens.)

## Prerequisites (manual, one-time — not code)

1. **Machine user + PAT.** Create a GitHub machine user (e.g. `eloquio-ci`), add to the Eloquio org with minimal role, generate a **classic PAT** with `write:packages` (+ `read:packages`). This account owns the publish credential so its blast radius is contained and it survives personnel changes.
2. **Org package settings.** Set new `@eloquio` npm packages to **internal** visibility so every Eloquio repo/member can install without per-package access grants. Decide whether to link packages to a source repo (inherits repo perms) or leave org-scoped with inheritance disabled — recommend **disable auto-inheritance + internal visibility** for clean org-wide read.
3. **Smoke test the credential** before wiring code: with the machine-user PAT, manually `npm publish` a throwaway `@eloquio/logger-smoketest@1.0.0` against `https://npm.pkg.github.com`, confirm it (a) creates a brand-new org-scoped package and (b) accepts a second version. Delete it after.
4. **Consumer onboarding doc** (separate, short): `.npmrc` with `@eloquio:registry=https://npm.pkg.github.com` + a read token (CI: `GITHUB_TOKEN`; local: `read:packages` PAT), then `pnpm add @eloquio/logger-<table>` and `pnpm add @aws-sdk/client-firehose` (peer dep). Note the consuming project still needs AWS creds with `firehose:PutRecordBatch` on the stream — packaging gives the code, not the write path.

## Dependencies to add (apps/web)

- `libnpmpublish` — programmatic publish (manifest + tarball Buffer + token).
- `npm-registry-fetch` — read the published packument (current version + embedded prior schema) for version derivation. (It's already a transitive dep of `libnpmpublish`; add explicitly.)
- `tar` — pack the tarball. Already pinned to `^7.5.13` via root `pnpm-workspace.yaml` overrides; add as a direct dep of `apps/web`.

All are Node libraries — the publish step must run on the **Node.js runtime** (WDK workflow steps already do; ensure no edge runtime).

## Environment variables (new)

Mirror the `FIREHOSE_ENABLED` gating pattern so local dev stays a no-op walking skeleton.

| Var | Purpose | Default |
|---|---|---|
| `GITHUB_PACKAGES_PUBLISH_ENABLED` | `"true"` to actually publish; anything else → deterministic no-op (records the would-be package + version) | unset (off) |
| `GITHUB_PACKAGES_TOKEN` | classic `write:packages` PAT from the machine user | — (required when enabled) |
| `GITHUB_PACKAGES_REGISTRY` | registry URL | `https://npm.pkg.github.com` |
| `GITHUB_PACKAGES_SCOPE` | npm scope = org namespace (lowercase) | `@eloquio` |

- Add to `apps/web/.env` (local, gitignored) — leave `GITHUB_PACKAGES_PUBLISH_ENABLED` unset locally.
- Set `GITHUB_PACKAGES_PUBLISH_ENABLED=true` + `GITHUB_PACKAGES_TOKEN` on Vercel **Production only**, token as a **Sensitive** env var.
- Document all four in the CLAUDE.md "Environment variables" section (production block), alongside the Firehose vars.

## Code changes

### 1. `apps/web/src/lib/logger-sdk-generator.ts` → render a *package*, not a file

Keep this module pure (no I/O). Replace `generateAndPublishLoggerSdk` (the S3 uploader) with a renderer that returns an in-memory file set. **Emit JS + `.d.ts` directly** so no `tsc`/build step runs in the function — the runtime is tiny.

```ts
export interface PackageFile { path: string; content: string }   // path relative to "package/"
export function renderLoggerPackage(table: LoggerTable, version: string): PackageFile[]
```

Files produced:
- `package.json` — ESM package:
  ```jsonc
  {
    "name": "@eloquio/logger-<sanitized-table>",   // "ingest.impressions" → "logger-ingest-impressions"
    "version": "<version>",
    "type": "module",
    "exports": { ".": { "types": "./index.d.ts", "import": "./index.js" } },
    "types": "./index.d.ts",
    "files": ["index.js", "index.d.ts", "README.md"],
    "publishConfig": { "registry": "https://npm.pkg.github.com" },
    "repository": "https://github.com/Eloquio/lattik-studio",
    "peerDependencies": { "@aws-sdk/client-firehose": "^3" },
    "lattikSchema": [{ "name": "...", "type": "..." }]   // custom field: normalized columns, for next run's diff
  }
  ```
- `index.d.ts` — the `<Pascal>Event` interface (reuse existing `tsTypeFor`) + `STREAM_NAME: string` + the `<Pascal>Logger` class signature.
- `index.js` — ESM runtime: `STREAM_NAME` const + `<Pascal>Logger` class with `send()` (the existing `PutRecordBatchCommand` body, as plain JS). Keep `@aws-sdk/client-firehose` imported at runtime.
- `README.md` — install + `.npmrc` snippet + usage (the header comment that's in the current generated file, expanded).

Helpers:
- `packageNameFor(tableName)`: `scope + "/logger-" + tableName.replace(/[.\_]/g, "-").toLowerCase()`.
- Keep `pascalCase`, `tsTypeFor` as-is.

### 2. New `apps/web/src/lib/github-packages.ts` → versioning + idempotent publish

Analogous to [firehose.ts](../apps/web/src/lib/firehose.ts). Owns all GH Packages I/O.

```ts
export interface PublishLoggerSdkResult {
  packageName: string;
  version: string;
  action: "created" | "published" | "unchanged" | "skipped";  // skipped = publish disabled (local)
  registryUrl: string;
  packageUrl: string;        // https://github.com/orgs/Eloquio/packages/npm/package/<name>
}
export async function publishLoggerSdk(table: LoggerTable): Promise<PublishLoggerSdkResult>
```

Flow:
1. Compute `packageName` and the **new schema signature** = normalized `[{name,type}]` sorted by name.
2. If `!GITHUB_PACKAGES_PUBLISH_ENABLED` → return `{ action: "skipped", version: "0.0.0-dev", ... }` without touching the network (local-dev walking skeleton, mirrors Firehose `skipped`).
3. Read the published packument via `npm-registry-fetch` (`registry`, `token`). 
   - 404 / no versions → first publish: `version = "1.0.0"`, `action = "created"`.
   - else read `versions[distTags.latest].lattikSchema` (the embedded prior columns) and `latest` version, then `version = computeVersionBump(prevSchema, newSchema, latestVersion)`.
4. If the new signature **equals** the prior signature → return `{ action: "unchanged", version: latestVersion }` **without publishing** (handles webhook redelivery / step retries cleanly, avoids 409s).
5. Else render files (`renderLoggerPackage(table, version)`), write to `/tmp/<uuid>/package/...`, pack with `tar.create({ gzip: true, cwd: "/tmp/<uuid>" }, ["package"])` → Buffer, then `libnpmpublish.publish(manifest, tarball, { registry, token, defaultTag: "latest" })`.
6. On HTTP **409** (version already exists) → treat as success (`action: "published"`), defensive against retries.

```ts
// Pure, unit-testable. No I/O.
export function computeVersionBump(
  prev: { name: string; type: string }[],
  next: { name: string; type: string }[],
  prevVersion: string,
): string
```
Rules:
- a column removed, renamed, or whose `type` changed → **major**
- a column added (no removals/retypes) → **minor**
- columns identical by (name,type) but description/tags/classification changed → **patch**
- byte-identical signature → caller skips (no bump); `computeVersionBump` itself still returns patch as a safe floor.

> Note: `access`/visibility is largely a no-op on GH Packages (it uses its own per-package visibility, defaulting private on first publish) — visibility is handled by the org setting in Prerequisite #2, not by the publish call.

### 3. `apps/web/src/workflows/post-pipeline-pr-merge.ts` → swap the SDK runner

- Replace the import `generateAndPublishLoggerSdk` → `publishLoggerSdk`.
- In `runLoggerTableStepsStep`, the second runner calls `publishLoggerSdk(t)` and returns the **new detail shape**:
  ```ts
  return { packageName, version, action, packageUrl };
  ```
  (Renders as "Package Name", "Version", "Action", "Package Url" via the existing generic `formatDetailKey` — no UI component change.)
- Update the step label in `LOGGER_TABLE_STEPS`: `"Generate TypeScript SDK client"` → `"Publish TypeScript SDK package"`.
- Keep the existing failure/skip-downstream and `log.info` plumbing; just change the event fields (`s3_uri/byte_length` → `package_name/version/action`).

### 4. UI

No component change required — the new `detail` keys render generically. Optionally make `packageUrl` a link in [step-detail-panel.tsx](../apps/web/src/app/workflows/_components/step-detail-panel.tsx) `formatDetailValue` (detect `http(s)://` → anchor). Small, optional polish.

### 5. Docs

- CLAUDE.md: add the four env vars to the production env block; update the Extensions/workflow prose that mentions the SDK step writing to S3.
- Add `docs/` note (or extend an existing one) describing the SDK package model + consumer onboarding.

## Idempotency & edge cases

- **Webhook redelivery / step retry:** signature-equal → `unchanged` (no-op). Version derivation is deterministic from the diff, so a retry recomputes the same version; a 409 is swallowed as success.
- **First publish of a new table:** classic PAT creates the org-scoped package (verified in Prerequisite #3); `action: "created"`, `version: 1.0.0`.
- **Spec fails to parse:** existing behavior — mark step failed (unchanged).
- **Local dev (no token):** `skipped`, deterministic `0.0.0-dev`, network untouched — workflow card still shows the step succeeding, same as Firehose today.
- **Breaking change:** major bump; consumers pin and upgrade deliberately. Only consumers of *that* table see the major.

## Testing / verification (gate before "done")

New unit tests (vitest, colocated):
- `logger-sdk-generator.test.ts`: `renderLoggerPackage` — assert `package.json` (name mapping, version, peerDeps, exports, embedded `lattikSchema`), `index.d.ts` contains the interface + class signature, `index.js` contains `STREAM_NAME` + class.
- `github-packages.test.ts`: `computeVersionBump` table-driven — add/remove/rename/retype/desc-only/identical. Plus the publish flow with mocked `npm-registry-fetch` + `libnpmpublish` covering created / published / unchanged / 409 / skipped branches.
- Extend [post-pipeline-pr-merge.test.ts](../apps/web/src/workflows/post-pipeline-pr-merge.test.ts) so the runner asserts the new detail shape.

Verification commands (must pass):
- `pnpm --filter web test` (or the web app's vitest script)
- web typecheck (`tsc --noEmit`) and `pnpm lint`
- **Manual prod-path check** (can't be unit-tested): with `GITHUB_PACKAGES_PUBLISH_ENABLED=true` + the machine-user PAT in a scratch env, merge a logger_table PR and confirm the package appears in the org's Packages tab, then merge an additive column change and confirm a **minor** bump, and a retype and confirm a **major** bump. Record the package URLs as evidence.

## Rollout / migration

- The S3 uploader (`putObject` to `firehose-sdks/<table>.ts`) is **removed**, not dual-run. Existing S3 files are harmless leftovers; optionally GC them later.
- Ship behind `GITHUB_PACKAGES_PUBLISH_ENABLED` so it's dark until the machine user + org settings are confirmed in production.

## Open decisions

1. **ESM vs CJS** for the generated package — plan assumes ESM (modern internal consumers). Switch to dual-emit only if a CJS-only consumer appears.
2. **Package ↔ repo linkage** — recommend org-scoped + internal visibility + inheritance disabled (Prerequisite #2); revisit if you want per-repo permission inheritance instead.
3. **`repository` field target** — `lattik-studio` (where the generator lives) vs `lattik-pipelines` (where definitions live). Plan uses `lattik-studio`; cosmetic.

## Out of scope

- Moving publish to GitHub Actions / using `GITHUB_TOKEN` (rejected: can't create org-scoped packages; requires extracting the generator into a CLI).
- Changing the runtime client's direct-to-Firehose model (the IAM/write-path question is separate).
- Auto-generating consumer `.npmrc` or AWS IAM policies.

## As-built notes (deviations from the plan above, after implementation + review)

- **Prior schema is read from the published *tarball*, not the packument field.** The plan assumed the next run reads `versions[latest].lattikSchema` from the packument. `npm-registry-fetch.json()` does request the *full* packument (no abbreviated/corgi header), which on npmjs.org preserves custom fields — but whether **GitHub Packages** preserves custom top-level `package.json` fields in its packument is unverified, and if it doesn't the versioning silently degrades to minor-bump-forever. So `fetchPublishedState` now reads `dist-tags.latest` + the version's `dist.tarball` URL from the packument, fetches that tarball, and extracts `lattikSchema` from its `package.json` (`readPackageJsonFromTarball`). This is registry-agnostic and correct regardless of packument field handling.
- **`classification` is part of the schema signature.** `ColumnSig` gained an optional `classification` (stable CSV of set PII/PHI/financial/credentials flags). A compliance reclassification now patch-bumps instead of being silently skipped. `description`/`tags`-only edits are still ignored (cosmetic → no version churn), a deliberate narrowing of the plan's "description/tags/classification → patch".
- **`access` is not set on publish.** GitHub Packages ignores the npm `access` field (visibility is org-controlled per Prerequisite #2); the explicit `access:'restricted'` was removed to avoid implying API-level access control.
- **Idempotency: 409 detection** matches `statusCode===409 || code==='E409'` plus an "already exists / cannot publish over" message fallback (the speculative `EPUBLISHCONFLICT` code, which no installed dep emits, was removed). A non-404 packument *read* failure is intentionally fatal — we never guess a version.
- **`packageUrl` is clickable** in the workflow card (`renderDetailValue` linkifies http(s) values).
- **Still requires the manual prod-path check** (plan's verification gate): confirm against the real registry that create-new-package, version-bump, and the tarball schema round-trip all behave as expected with the machine-user PAT.
