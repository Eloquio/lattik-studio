import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DefinitionKind } from "@eloquio/db-schema";
import { listMergedDefinitions, listMergedDefinitionNames } from "@/agents/DataArchitect/lib/definitions";
import {
  loggerTableSchema,
  lattikTableSchema,
  type LoggerTable,
  type LattikTable,
} from "@/agents/DataArchitect/lib/schema";
import {
  validateAgainstSnapshot,
  type ValidationSnapshot,
} from "@/agents/DataArchitect/lib/validation";
import { log } from "@/lib/log";
import {
  parseDefinitionPath,
  parseDefinitionYaml,
} from "@/lib/definitions-from-yaml";
import {
  getFileAtRef,
  listPullRequestFiles,
} from "@/lib/github-client";

/**
 * Pre-merge validator hit by the GitHub Action on every PR that touches
 * `definitions/**\/*.yaml`. Returns 200 with `{ ok, errors }` regardless of
 * validation outcome — the GHA reads the body to decide pass/fail, so an
 * HTTP 4xx would fail the check for the wrong reason. Real auth/transport
 * errors still 4xx/5xx as usual.
 *
 * This is the slice where referential validation actually runs (deferred
 * from the post-merge reconciler, which can't snapshot mid-write). The
 * snapshot is built from current merged defs in the DB, with the PR's own
 * adds/modifies layered in so PRs that introduce a new entity + a new
 * dimension referencing it validate cleanly.
 */
const bodySchema = z.object({
  prNumber: z.number().int().positive(),
  sha: z.string().min(1),
});

class SecretMissingError extends Error {
  constructor() {
    super(
      "LATTIK_VALIDATE_PR_SECRET is not configured. Refusing to accept validation calls.",
    );
  }
}

function verifyBearer(header: string | null): boolean {
  const secret = process.env.LATTIK_VALIDATE_PR_SECRET;
  if (!secret) throw new SecretMissingError();
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  let authOk = false;
  try {
    authOk = verifyBearer(req.headers.get("authorization"));
  } catch (err) {
    if (err instanceof SecretMissingError) {
      log.error("validate_pr.misconfigured", { error: err.message });
      return Response.json(
        { error: "Server misconfigured: validate-pr secret missing" },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!authOk) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsedBody: z.infer<typeof bodySchema>;
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid body", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    parsedBody = parsed.data;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { prNumber, sha } = parsedBody;

  let files: Awaited<ReturnType<typeof listPullRequestFiles>>;
  try {
    files = await listPullRequestFiles(prNumber);
  } catch (err) {
    log.error("validate_pr.list_files_failed", {
      pr_number: prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: "Failed to list PR files" },
      { status: 502 },
    );
  }

  // Collect everything in the PR that maps to a definition path. Split
  // into upsert (need content) and remove (identity only) so the snapshot
  // layering is correct.
  type Upsert = { kind: DefinitionKind; name: string; path: string };
  type Remove = { kind: DefinitionKind; name: string };
  const upserts: Upsert[] = [];
  const removes: Remove[] = [];
  for (const f of files) {
    if (f.status === "removed") {
      const id = parseDefinitionPath(f.path);
      if (id) removes.push(id);
      continue;
    }
    if (f.status === "renamed") {
      if (f.previousFilename) {
        const prev = parseDefinitionPath(f.previousFilename);
        if (prev) removes.push(prev);
      }
      const next = parseDefinitionPath(f.path);
      if (next) upserts.push({ ...next, path: f.path });
      continue;
    }
    if (
      f.status === "added" ||
      f.status === "modified" ||
      f.status === "copied" ||
      f.status === "changed"
    ) {
      const id = parseDefinitionPath(f.path);
      if (id) upserts.push({ ...id, path: f.path });
    }
  }

  if (upserts.length === 0 && removes.length === 0) {
    return Response.json({ ok: true, errors: [] });
  }

  // Fetch + parse + shape-validate each upsert. Files that fail this stage
  // are reported immediately and excluded from the snapshot so they can't
  // accidentally satisfy other files' referential checks.
  type PendingDef = {
    kind: DefinitionKind;
    name: string;
    path: string;
    spec: unknown;
  };
  const pending: PendingDef[] = [];
  const errors: Array<{ path: string; message: string }> = [];

  await Promise.all(
    upserts.map(async (u) => {
      let raw: string;
      try {
        raw = await getFileAtRef(u.path, sha);
      } catch (err) {
        errors.push({
          path: u.path,
          message: `Failed to fetch file at ref ${sha}: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      let spec: unknown;
      try {
        spec = parseDefinitionYaml(raw);
      } catch (err) {
        errors.push({
          path: u.path,
          message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      pending.push({ ...u, spec });
    }),
  );

  // Build a virtual snapshot: (DB merged defs) ∪ (PR upserts) − (PR removes).
  // Names are sufficient for entity/dimension existence checks; tables need
  // full parsed specs so column-level checks work.
  const removedByKind = new Map<DefinitionKind, Set<string>>();
  for (const r of removes) {
    const set = removedByKind.get(r.kind) ?? new Set<string>();
    set.add(r.name);
    removedByKind.set(r.kind, set);
  }
  const pendingByKind = new Map<DefinitionKind, PendingDef[]>();
  for (const p of pending) {
    const list = pendingByKind.get(p.kind) ?? [];
    list.push(p);
    pendingByKind.set(p.kind, list);
  }

  const [
    dbEntityNames,
    dbDimensionNames,
    dbLoggerNames,
    dbLattikNames,
    dbLoggerDefs,
    dbLattikDefs,
  ] = await Promise.all([
    listMergedDefinitionNames("entity"),
    listMergedDefinitionNames("dimension"),
    listMergedDefinitionNames("logger_table"),
    listMergedDefinitionNames("lattik_table"),
    listMergedDefinitions("logger_table"),
    listMergedDefinitions("lattik_table"),
  ]);

  // Names sets layered: drop removed, add pending.
  function buildNames(
    kind: DefinitionKind,
    base: Array<{ name: string }>,
  ): Set<string> {
    const removed = removedByKind.get(kind) ?? new Set<string>();
    const out = new Set<string>();
    for (const r of base) if (!removed.has(r.name)) out.add(r.name);
    for (const p of pendingByKind.get(kind) ?? []) out.add(p.name);
    return out;
  }

  const entityNames = buildNames("entity", dbEntityNames);
  const dimensionNames = buildNames("dimension", dbDimensionNames);
  const loggerTableNames = buildNames("logger_table", dbLoggerNames);
  const lattikTableNames = buildNames("lattik_table", dbLattikNames);

  // Tables need the parsed spec so column checks work. Layer DB defs minus
  // removed, then in-PR upserts whose spec parses cleanly through the table
  // schema. (A spec that fails the table schema is reported as a shape
  // error by the per-file validator below — it just doesn't contribute to
  // the table snapshot.)
  const removedLogger = removedByKind.get("logger_table") ?? new Set<string>();
  const removedLattik = removedByKind.get("lattik_table") ?? new Set<string>();
  const loggerTables: LoggerTable[] = [];
  const lattikTables: LattikTable[] = [];
  for (const row of dbLoggerDefs) {
    if (removedLogger.has(row.name)) continue;
    const parsed = loggerTableSchema.safeParse(row.spec);
    if (parsed.success) loggerTables.push(parsed.data);
  }
  for (const row of dbLattikDefs) {
    if (removedLattik.has(row.name)) continue;
    const parsed = lattikTableSchema.safeParse(row.spec);
    if (parsed.success) lattikTables.push(parsed.data);
  }
  for (const p of pendingByKind.get("logger_table") ?? []) {
    const parsed = loggerTableSchema.safeParse(p.spec);
    if (parsed.success) loggerTables.push(parsed.data);
  }
  for (const p of pendingByKind.get("lattik_table") ?? []) {
    const parsed = lattikTableSchema.safeParse(p.spec);
    if (parsed.success) lattikTables.push(parsed.data);
  }

  const snapshot: ValidationSnapshot = {
    entityNames,
    dimensionNames,
    loggerTableNames,
    lattikTableNames,
    loggerTables,
    lattikTables,
  };

  // Validate every pending definition against the snapshot.
  for (const p of pending) {
    const res = validateAgainstSnapshot(p.kind, p.spec, snapshot);
    if (!res.passed) {
      for (const e of res.errors) {
        errors.push({
          path: p.path,
          message: `${e.field}: ${e.message}`,
        });
      }
    }
  }

  return Response.json({ ok: errors.length === 0, errors });
}
