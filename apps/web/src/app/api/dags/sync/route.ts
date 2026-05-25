import { z } from "zod";
import { requireBearer } from "@/lib/bearer-auth";
import { log } from "@/lib/log";
import {
  ManifestMissingError,
  reconcileDags,
} from "@/lib/dag-reconciler";
import { manifestSchema } from "@/schemas/manifest";
import type { Branch } from "@/lib/dag-blob";

const branchSchema = z.union([
  z.literal("prod"),
  z.string().regex(/^pr-\d+$/),
]);

const syncBodySchema = z.object({
  branch: branchSchema,
  bundleSha: z.string().min(1),
  /** Inline manifest written by lattik-pipelines' GHA. Skips Blob fetch. */
  manifest: manifestSchema.optional(),
});

/**
 * POST /api/dags/sync — called by lattik-pipelines' GHA after uploading the
 * bundle + manifest to Vercel Blob. Reconciles the `dags` table for the
 * given branch.
 *
 * Auth: bearer token in `LATTIK_DAGS_SYNC_TOKEN`. Vercel OIDC verification
 * can replace this later once we wire up federated trust with
 * lattik-pipelines.
 */
export async function POST(req: Request) {
  const denial = requireBearer(req, "LATTIK_DAGS_SYNC_TOKEN");
  if (denial) return denial;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = syncBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { branch, bundleSha, manifest } = parsed.data;
  log.info("dags_sync.start", {
    branch,
    bundleSha,
    inline_manifest: Boolean(manifest),
    dag_count: manifest?.dags.length,
  });

  try {
    const result = await reconcileDags(branch as Branch, bundleSha, {
      manifest,
    });
    log.info("dags_sync.done", { ...result });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ManifestMissingError) {
      log.warn("dags_sync.manifest_missing", { branch });
      return Response.json(
        { error: err.message },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("dags_sync.failed", { branch, error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
