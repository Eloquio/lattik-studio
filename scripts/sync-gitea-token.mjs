#!/usr/bin/env node
// Reads the gitea-init Job logs (which print `GITEA_TOKEN=<value>` after
// creating the API token) and writes the token into apps/web/.env.
//
// Runs after `pnpm gitea:start` as part of `pnpm dev:up`. Idempotent — if
// the token in .env already matches what the Job printed, this is a no-op.
//
// Assumes the gitea-init Job has already completed. `gitea:start` now waits
// for `--for=condition=complete` before returning, so by the time this runs
// the logs are stable.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(SCRIPT_DIR, "../apps/web/.env");

if (!existsSync(ENV_PATH)) {
  console.error("[gitea:token-sync] apps/web/.env does not exist — run `pnpm env:bootstrap` first.");
  process.exit(1);
}

let logs;
try {
  logs = execFileSync(
    "kubectl",
    ["-n", "gitea", "logs", "job/gitea-init"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  console.error("[gitea:token-sync] Failed to read gitea-init job logs:");
  console.error(err.stderr?.toString() || err.message);
  process.exit(1);
}

const match = logs.match(/^GITEA_TOKEN=([a-f0-9]{30,})$/m);
if (!match) {
  console.error("[gitea:token-sync] Could not find GITEA_TOKEN in gitea-init logs.");
  console.error("                   Check `pnpm gitea:init-logs` and create a token manually");
  console.error("                   at http://localhost:3300 if needed.");
  process.exit(1);
}
const token = match[1];

let env = readFileSync(ENV_PATH, "utf8");
const existing = env.match(/^GITEA_TOKEN=(.*)$/m);

if (existing && existing[1] === token) {
  console.log("[gitea:token-sync] GITEA_TOKEN already up to date.");
  process.exit(0);
}

if (existing) {
  env = env.replace(/^GITEA_TOKEN=.*$/m, `GITEA_TOKEN=${token}`);
} else {
  // Append with a trailing newline if .env didn't already end with one.
  env = env.endsWith("\n") ? `${env}GITEA_TOKEN=${token}\n` : `${env}\nGITEA_TOKEN=${token}\n`;
}

writeFileSync(ENV_PATH, env);
console.log("[gitea:token-sync] Wrote GITEA_TOKEN to apps/web/.env");
