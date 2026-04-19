/**
 * Register a single local-dev worker that hosts every agent the agent-worker
 * process runs, then write its credentials into apps/agent-worker/.env.
 *
 * Idempotent: if a worker with `LOCAL_WORKER_ID` already exists, this
 * rotates its secret — on a fresh boot that's safe, because the worker
 * process reads the updated env and comes up with the new token. In prod
 * we'd prefer explicit rotation tooling; for local dev, replace-on-boot
 * keeps the env file and DB in lockstep.
 *
 * Run order: after `db:seed`. See scripts/bootstrap.sh.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerWorker } from "../lib/worker-tokens";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_ENV_PATH = resolve(SCRIPT_DIR, "../../../agent-worker/.env");

const LOCAL_WORKER_ID = "local-dev-worker";
const LOCAL_WORKER_NAME = "Local Dev Worker";

function upsertEnv(kv: Record<string, string>) {
  const existing = existsSync(WORKER_ENV_PATH)
    ? readFileSync(WORKER_ENV_PATH, "utf8").split("\n")
    : [];
  for (const [key, value] of Object.entries(kv)) {
    const line = `${key}=${value}`;
    const idx = existing.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) existing[idx] = line;
    else existing.push(line);
  }
  mkdirSync(dirname(WORKER_ENV_PATH), { recursive: true });
  writeFileSync(WORKER_ENV_PATH, existing.filter(Boolean).join("\n") + "\n");
}

async function main() {
  const secret = await registerWorker({
    id: LOCAL_WORKER_ID,
    name: LOCAL_WORKER_NAME,
  });

  upsertEnv({
    LATTIK_WORKER_ID: LOCAL_WORKER_ID,
    LATTIK_WORKER_SECRET: secret,
  });

  console.log(`[worker-bootstrap] Registered "${LOCAL_WORKER_ID}"`);
  console.log(`[worker-bootstrap] Wrote credentials to ${WORKER_ENV_PATH}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
