import { and, eq, inArray } from "drizzle-orm";
import type { DefinitionKind } from "@eloquio/db-schema";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { SYSTEM_USER_ID, upsertSystemUser } from "@/db/system-user";
import { validateShape } from "@/agents/DataArchitect/lib/validation";
import { getFileAtRef, listPullRequestFiles } from "./github-client";
import { parseDefinitionPath, parseDefinitionYaml } from "./definitions-from-yaml";

export interface ReconciledAdd {
  kind: DefinitionKind;
  name: string;
  definitionId: string;
}
export interface ReconciledModify {
  kind: DefinitionKind;
  name: string;
  definitionId: string;
}
export interface ReconciledDelete {
  kind: DefinitionKind;
  name: string;
  definitionId: string | null;
}
export interface ReconciledInvalid {
  kind: DefinitionKind;
  name: string;
  definitionId: string;
  error: string;
}

export interface ReconcileResult {
  added: ReconciledAdd[];
  modified: ReconciledModify[];
  deleted: ReconciledDelete[];
  invalid: ReconciledInvalid[];
}

interface ChangedDefinition {
  kind: DefinitionKind;
  name: string;
  path: string;
  /** "added" / "modified" if we need to fetch + parse content; "removed" otherwise. */
  op: "upsert" | "remove";
}

/**
 * Reconcile `definitions` rows against the YAML files actually changed by a
 * merged PR. Git is the source of truth: any merged PR that touches
 * `definitions/**\/*.yaml` updates the DB regardless of whether the PR was
 * opened via the data-architect agent or hand-edited on GitHub.
 *
 * Strategy
 * --------
 * 1. Pull the file diff from the GitHub PR.
 * 2. Filter to the `definitions/{kind_dir}/{name}.yaml` convention; everything
 *    else is ignored here.
 * 3. For added/modified entries: fetch the post-merge content, parse YAML,
 *    run shape-only validation, then upsert by (kind, name).
 * 4. For removed entries: delete by (kind, name).
 * 5. Renames decompose into one delete + one add — works but the new row
 *    gets a fresh id and loses prior history; called out in the plan.
 *
 * Validation policy
 * -----------------
 * Bad YAML is *not* a reason to reject the merge — the PR is already in
 * `main`. We upsert the row with `status='invalid'` and record the error in
 * the audit log so the /workflows view surfaces it. Downstream side effects
 * (DAG generation, topic creation, schema registration) will skip these.
 *
 * Referential validation is deferred to the pre-merge GHA path, which can
 * build a virtual snapshot from DB + in-PR defs. Doing it post-merge would
 * require either a long-held transaction or a "validate-after" pass that
 * flips rows post-hoc — both are heavier than this slice warrants.
 */
export async function reconcileDefinitionsFromPR(args: {
  prUrl: string;
  prNumber: number;
  mergeCommitSha: string;
}): Promise<ReconcileResult> {
  const { prUrl, prNumber, mergeCommitSha } = args;

  const files = await listPullRequestFiles(prNumber);

  const changed: ChangedDefinition[] = [];
  for (const f of files) {
    if (f.status === "removed") {
      const id = parseDefinitionPath(f.path);
      if (id) changed.push({ ...id, path: f.path, op: "remove" });
      continue;
    }
    if (f.status === "renamed") {
      // Treat rename as delete-of-old + add-of-new. The old identity comes
      // from previousFilename (which is what the rest of the diff lacks).
      if (f.previousFilename) {
        const prev = parseDefinitionPath(f.previousFilename);
        if (prev) changed.push({ ...prev, path: f.previousFilename, op: "remove" });
      }
      const next = parseDefinitionPath(f.path);
      if (next) changed.push({ ...next, path: f.path, op: "upsert" });
      continue;
    }
    // added | modified | copied | changed → treat as upsert with current content.
    if (
      f.status === "added" ||
      f.status === "modified" ||
      f.status === "copied" ||
      f.status === "changed"
    ) {
      const id = parseDefinitionPath(f.path);
      if (id) changed.push({ ...id, path: f.path, op: "upsert" });
    }
    // "unchanged" is silly to see in a PR file list, but harmless to skip.
  }

  if (changed.length === 0) {
    return { added: [], modified: [], deleted: [], invalid: [] };
  }

  const db = getDb();
  // Self-heal the FK target before any insert. Reconcile attributes
  // hand-edited / webhook-authored definitions to SYSTEM_USER_ID
  // (definitions.createdBy → user.id), but that user is otherwise only created
  // by `pnpm db:seed`. Without this, the first brand-new definition insert in
  // an unseeded environment (fresh DB, new branch, reset) FK-fails and the
  // whole reconcile throws. Idempotent: selects first, inserts only if missing.
  await upsertSystemUser(db);
  const prMergedAt = new Date();
  const result: ReconcileResult = {
    added: [],
    modified: [],
    deleted: [],
    invalid: [],
  };

  // Look up existing rows for everything we touch. We need this to know
  // (a) whether an upsert is an add or a modify (for audit), and (b) the
  // existing id so deletes can report it.
  const existingRows = await loadExistingRows(changed);
  const existingByKey = new Map(
    existingRows.map((r) => [`${r.kind}::${r.name}`, r]),
  );

  for (const c of changed) {
    const key = `${c.kind}::${c.name}`;
    const existing = existingByKey.get(key);

    if (c.op === "remove") {
      if (existing) {
        await db
          .delete(schema.definitions)
          .where(eq(schema.definitions.id, existing.id));
        result.deleted.push({
          kind: c.kind,
          name: c.name,
          definitionId: existing.id,
        });
      } else {
        // The file was removed but the DB never had a matching row — still
        // worth recording as a "deletion" event so the audit story is
        // complete from a git perspective.
        result.deleted.push({
          kind: c.kind,
          name: c.name,
          definitionId: null,
        });
      }
      // Wipe the cache entry so a same-PR rename (delete-then-add) doesn't
      // see a stale existing row.
      existingByKey.delete(key);
      continue;
    }

    // op === "upsert"
    let raw: string;
    try {
      raw = await getFileAtRef(c.path, mergeCommitSha);
    } catch (err) {
      // Couldn't even fetch the file — treat as invalid so we still surface
      // something in the audit log. We can't upsert without content, so the
      // row stays as whatever it was before (or absent).
      const definitionId = existing?.id ?? (await insertInvalidPlaceholder(c, prUrl, prMergedAt));
      result.invalid.push({
        kind: c.kind,
        name: c.name,
        definitionId,
        error: `Failed to fetch '${c.path}' from PR: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    let spec: unknown;
    try {
      spec = parseDefinitionYaml(raw);
    } catch (err) {
      const { definitionId, wasAdd } = await upsertRow({
        kind: c.kind,
        name: c.name,
        spec: { __raw: raw }, // best-effort: keep the bad content for debugging
        status: "invalid",
        prUrl,
        prMergedAt,
        existingId: existing?.id,
      });
      result.invalid.push({
        kind: c.kind,
        name: c.name,
        definitionId,
        error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
      // Track add-vs-modify for cache symmetry but don't add to result.added/modified —
      // an invalid row is surfaced under .invalid, not both.
      void wasAdd;
      continue;
    }

    const shape = validateShape(c.kind, spec);
    const status: "merged" | "invalid" = shape.passed ? "merged" : "invalid";

    const { definitionId, wasAdd } = await upsertRow({
      kind: c.kind,
      name: c.name,
      spec,
      status,
      prUrl,
      prMergedAt,
      existingId: existing?.id,
    });

    if (status === "invalid") {
      const message = shape.errors
        .map((e) => `${e.field}: ${e.message}`)
        .join("; ");
      result.invalid.push({
        kind: c.kind,
        name: c.name,
        definitionId,
        error: message || "Shape validation failed",
      });
    } else if (wasAdd) {
      result.added.push({ kind: c.kind, name: c.name, definitionId });
    } else {
      result.modified.push({ kind: c.kind, name: c.name, definitionId });
    }
  }

  return result;
}

async function loadExistingRows(
  changed: ChangedDefinition[],
): Promise<Array<{ id: string; kind: DefinitionKind; name: string }>> {
  const db = getDb();
  // Group by kind so we can do one `IN (...)` query per kind. The
  // alternative — one query per (kind, name) — would issue N round-trips
  // for a PR touching N files.
  const byKind = new Map<DefinitionKind, string[]>();
  for (const c of changed) {
    const list = byKind.get(c.kind) ?? [];
    list.push(c.name);
    byKind.set(c.kind, list);
  }

  const out: Array<{ id: string; kind: DefinitionKind; name: string }> = [];
  for (const [kind, names] of byKind) {
    if (names.length === 0) continue;
    const rows = await db
      .select({
        id: schema.definitions.id,
        kind: schema.definitions.kind,
        name: schema.definitions.name,
      })
      .from(schema.definitions)
      .where(
        and(
          eq(schema.definitions.kind, kind),
          inArray(schema.definitions.name, names),
        ),
      );
    out.push(...rows);
  }
  return out;
}

/**
 * Insert-or-update on (kind, name). On insert, set `createdBy = SYSTEM_USER_ID`
 * so the FK is satisfied for hand-made PRs. On update, leave `createdBy`
 * alone so the original author keeps ownership in the UI.
 *
 * Returns the row id and whether this was an insert (so the caller can
 * classify the change as `added` vs `modified` for the audit log).
 */
async function upsertRow(args: {
  kind: DefinitionKind;
  name: string;
  spec: unknown;
  status: "merged" | "invalid";
  prUrl: string;
  prMergedAt: Date;
  existingId: string | undefined;
}): Promise<{ definitionId: string; wasAdd: boolean }> {
  const db = getDb();
  const { kind, name, spec, status, prUrl, prMergedAt, existingId } = args;

  if (existingId) {
    await db
      .update(schema.definitions)
      .set({
        spec,
        status,
        prUrl,
        prMergedAt,
        updatedAt: prMergedAt,
      })
      .where(eq(schema.definitions.id, existingId));
    return { definitionId: existingId, wasAdd: false };
  }

  const [inserted] = await db
    .insert(schema.definitions)
    .values({
      kind,
      name,
      spec,
      status,
      prUrl,
      prMergedAt,
      createdBy: SYSTEM_USER_ID,
    })
    .returning({ id: schema.definitions.id });
  return { definitionId: inserted.id, wasAdd: true };
}

/**
 * Fallback used when we couldn't fetch the file content at all. We still
 * want an audit row pointing at *some* definitionId, so insert a stub
 * marked invalid. Real reconciliation happens on the next PR that touches
 * the same file.
 */
async function insertInvalidPlaceholder(
  c: ChangedDefinition,
  prUrl: string,
  prMergedAt: Date,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.definitions)
    .values({
      kind: c.kind,
      name: c.name,
      spec: {},
      status: "invalid",
      prUrl,
      prMergedAt,
      createdBy: SYSTEM_USER_ID,
    })
    .returning({ id: schema.definitions.id });
  return row.id;
}
