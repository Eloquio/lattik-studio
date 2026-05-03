import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineNitroConfig } from "nitropack/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Workaround for a path-resolution bug between `@workflow/builders` (which
 * bundles step files via esbuild + `withRealpaths()`, emitting absolute
 * `<root>/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...` import
 * paths) and nitropack@2's rollup pass (which mishandles those paths when
 * inlining and produces a broken specifier that drops the
 * `node_modules/.pnpm/` segment).
 *
 * The plugin forces inlining of any `@workflow/*` source file reached via
 * an absolute `.pnpm/*` path, so rollup never has to emit a relative
 * specifier for it in the output bundle. The on-disk content is loaded
 * directly. Only `@workflow/*` is targeted because they're the only
 * packages whose deep internal relative imports leak out of the esbuild
 * step bundle.
 */
const PNPM_WORKFLOW_RE =
  /\/node_modules\/\.pnpm\/[^/]+\/node_modules\/(@workflow\/[a-zA-Z0-9._-]+)\/.+\.[mc]?js$/;
const fixWorkflowPnpmPaths = {
  name: "fix-workflow-pnpm-paths",
  enforce: "pre" as const,
  resolveId(id: string, importer: string | undefined) {
    if (id.startsWith(".") && importer) {
      // Absolute-resolve a relative `../@workflow/*` import so the regex match
      // below can see the full pnpm path. Without this, node-externals sees
      // the still-relative form and skips it.
      const resolved = resolve(dirname(importer), id);
      if (PNPM_WORKFLOW_RE.test(resolved)) {
        return { id: resolved, external: false, moduleSideEffects: "no-treeshake" as const };
      }
      return null;
    }
    if (PNPM_WORKFLOW_RE.test(id)) {
      return { id, external: false, moduleSideEffects: "no-treeshake" as const };
    }
    return null;
  },
};

export default defineNitroConfig({
  srcDir: "src",
  compatibilityDate: "2026-05-02",
  modules: ["workflow/nitro"],
  // The workflow/nitro plugin emits step/workflow/webhook bundles into
  // `.nitro/workflow/` whose only purpose is top-level `registerStepFunction`
  // side effects. nitropack's default rollup tree-shake assumes all modules
  // outside its runtime polyfill allowlist are pure, so without this entry
  // the side-effect imports get dropped and steps are missing at runtime.
  moduleSideEffects: [resolve(rootDir, ".nitro/workflow/")],
  rollupConfig: {
    plugins: [fixWorkflowPnpmPaths],
  },
  // Vercel deployment auto-detected via NITRO_PRESET=vercel in CI; locally the
  // dev server listens on :3000 by default via nitropack dev.
  experimental: {
    asyncContext: true,
  },
});
