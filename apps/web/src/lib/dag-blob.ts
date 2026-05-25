import { get, head, list, put } from "@vercel/blob";
import { manifestSchema, type Manifest } from "@/schemas/manifest";

/**
 * Vercel Blob layout used by lattik-pipelines' GitHub Action:
 *
 *   bundles/prod.js                        ← compiled task code (overwritten on every merge to main)
 *   bundles/prod.sha.txt                   ← sidecar holding the SHA of the bundle just uploaded
 *   bundles/prod-dags/<id>.yaml            ← every DAG file from main
 *   bundles/prod-dags/manifest.json        ← `{ version, dags: [{ path, sha256 }] }`
 *
 *   bundles/pr-42.js
 *   bundles/pr-42.sha.txt
 *   bundles/pr-42-dags/<id>.yaml
 *   bundles/pr-42-dags/manifest.json
 *
 * The reconciler is manifest-driven: a branch with no manifest is treated
 * as "not yet synced" and the caller (e.g. /api/sync) fails closed.
 */

export type Branch = "prod" | `pr-${number}`;

/** Decode a Branch into the task-context shape. */
export function parseBranch(branch: Branch): {
  isPrTest: boolean;
  prNumber: number | null;
} {
  if (branch === "prod") return { isPrTest: false, prNumber: null };
  return { isPrTest: true, prNumber: Number(branch.slice(3)) };
}

export const blobPaths = {
  bundle: (branch: Branch) => `bundles/${branch}.js`,
  sha: (branch: Branch) => `bundles/${branch}.sha.txt`,
  dagsPrefix: (branch: Branch) => `bundles/${branch}-dags/`,
  manifest: (branch: Branch) => `bundles/${branch}-dags/manifest.json`,
  taskLog: (dagRunId: string, taskId: string, attempt: number) =>
    `logs/${dagRunId}/${taskId}/${attempt}.log`,
};

/** Read the recorded SHA for a branch's bundle. Returns null if missing. */
export async function readBundleSha(branch: Branch): Promise<string | null> {
  try {
    const result = await get(blobPaths.sha(branch), { access: "private" });
    if (!result || result.statusCode !== 200) return null;
    const text = await new Response(result.stream).text();
    return text.trim();
  } catch {
    return null;
  }
}

/** Resolve the bundle's HTTPS URL (auth-required for private blobs). */
export async function getBundleUrl(branch: Branch): Promise<string> {
  const meta = await head(blobPaths.bundle(branch));
  return meta.url;
}

/** Read a private Blob's body as text. */
export async function fetchBlobText(pathname: string): Promise<string> {
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(
      `blob fetch failed: status ${result?.statusCode ?? "unknown"}`
    );
  }
  return new Response(result.stream).text();
}

/** Read a private Blob's body as bytes (for shipping into a Sandbox). */
export async function fetchBlobBytes(pathname: string): Promise<Buffer> {
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(
      `blob fetch failed: status ${result?.statusCode ?? "unknown"}`
    );
  }
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

/** Read a private Blob's body as text, returning null when missing. */
export async function fetchBlobTextOrNull(
  pathname: string
): Promise<string | null> {
  try {
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return await new Response(result.stream).text();
  } catch {
    return null;
  }
}

/**
 * Read and validate manifest.json for a branch. Returns null when missing
 * (caller is expected to fail closed — the reconciler refuses to read YAMLs
 * without a manifest). Throws on malformed JSON / schema.
 */
export async function fetchManifest(
  branch: Branch
): Promise<Manifest | null> {
  const text = await fetchBlobTextOrNull(blobPaths.manifest(branch));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `manifest.json for ${branch} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return manifestSchema.parse(raw);
}

/** Write a text body to a private Blob at the given pathname. */
export async function putBlobText(
  pathname: string,
  body: string
): Promise<void> {
  await put(pathname, body, {
    access: "private",
    contentType: "text/plain; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/** List the YAML files under `bundles/<branch>-dags/`. */
export async function listDagBlobs(branch: Branch) {
  const result = await list({ prefix: blobPaths.dagsPrefix(branch) });
  return result.blobs.filter(
    (b) => b.pathname.endsWith(".yaml") || b.pathname.endsWith(".yml")
  );
}
