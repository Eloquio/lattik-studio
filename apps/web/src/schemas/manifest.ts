import { z } from "zod";

/**
 * Shape of `bundles/<branch>-dags/manifest.json` written by lattik-pipelines'
 * GitHub Action. The reconciler reads it (or accepts an inline copy from
 * /api/sync) to decide which DAG YAMLs changed.
 *
 * `sha256` is the hex digest of the YAML file's bytes — used both as a
 * cache key (skip-fetch when DB row's `yaml_hash` matches) and pinned onto
 * dag_runs.manifest_sha so a YAML edit between enqueue and launch is
 * detected at launch time.
 */
export const manifestEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  dags: z.array(manifestEntrySchema),
});

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type Manifest = z.infer<typeof manifestSchema>;
