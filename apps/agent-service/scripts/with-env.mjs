#!/usr/bin/env node
/**
 * Loads layered .env files into process.env, then execs the rest of the
 * argv as a child process. Used by agent-service's `dev` and `preview`
 * scripts so the long list of shared dev creds (AI Gateway key, Gitea
 * token, DATABASE_URL, …) doesn't have to be marshalled on the command
 * line every restart.
 *
 * Load order (later wins):
 *   1. ../web/.env   — single source of truth for dev creds, owned by
 *                       the bootstrap-env script.
 *   2. ./.env        — agent-service-specific overrides (PORT,
 *                       LATTIK_DEV_AUTH_BYPASS, LATTIK_DEV_TRUSTED_CLIENTS,
 *                       …). See .env.example.
 *
 * Both files are optional (loaded via `loadEnvFile` only if `existsSync`
 * is true). Existing process.env values from the parent shell are
 * preserved by passing the same env object through to the child.
 *
 * Why a wrapper instead of `node --env-file-if-exists=...`?
 *   - Node's `--env-file*` flags work on a direct `node ...` invocation
 *     (so `preview` could use them) but NOT through `NODE_OPTIONS`
 *     (Node rejects them: "--env-file= is not allowed in NODE_OPTIONS").
 *   - `nitropack dev` is its own CLI — there's no clean way to get
 *     `node --env-file ...` to run before it without spawning a child
 *     anyway. Doing the load programmatically here keeps `dev` and
 *     `preview` consistent.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = resolve(SCRIPT_DIR, "..");

const ENV_FILES = [
  resolve(SERVICE_DIR, "../web/.env"),
  resolve(SERVICE_DIR, ".env"),
];

for (const path of ENV_FILES) {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("[with-env] usage: with-env.mjs <command> [args...]");
  process.exit(2);
}

// Resolve PATH-only commands (like `nitropack`) by checking
// node_modules/.bin first, falling back to the original name so absolute
// paths and built-ins like `node` still work. Avoids `shell: true`,
// which carries a Node deprecation warning when args are passed.
const localBin = resolve(SERVICE_DIR, "node_modules/.bin", cmd);
const resolved = existsSync(localBin) ? localBin : cmd;

const child = spawn(resolved, args, {
  stdio: "inherit",
  env: process.env,
  cwd: SERVICE_DIR,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});

// Forward common termination signals so Ctrl-C in the parent shell
// reaches the wrapped process cleanly.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
