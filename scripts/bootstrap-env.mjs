#!/usr/bin/env node
// Creates apps/web/.env (the source of truth for dev creds), plus
// apps/agent-worker/.env and apps/agent-service/.env on first run.
// Idempotent: each file is only created if missing.
//
// agent-service/.env carries ONLY agent-service-specific overrides.
// Shared creds (AI Gateway key, Gitea token, DATABASE_URL, etc.) are
// loaded at runtime from apps/web/.env via the with-env.mjs wrapper —
// rotating a value in web/.env propagates automatically without a
// re-bootstrap.

import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = resolve(SCRIPT_DIR, "../apps/web/.env.example");
const ENV_PATH = resolve(SCRIPT_DIR, "../apps/web/.env");

const AGENT_WORKER_ENV_PATH = resolve(SCRIPT_DIR, "../apps/agent-worker/.env");
const AGENT_SERVICE_ENV_PATH = resolve(
  SCRIPT_DIR,
  "../apps/agent-service/.env",
);
const AGENT_SERVICE_ENV_EXAMPLE = resolve(
  SCRIPT_DIR,
  "../apps/agent-service/.env.example",
);

if (
  existsSync(ENV_PATH) &&
  existsSync(AGENT_WORKER_ENV_PATH) &&
  existsSync(AGENT_SERVICE_ENV_PATH)
) {
  console.log("[env:bootstrap] all dev .env files already exist — skipping.");
  process.exit(0);
}

if (!existsSync(EXAMPLE_PATH)) {
  console.error("[env:bootstrap] apps/web/.env.example not found — cannot bootstrap.");
  process.exit(1);
}

// Prompt for the AI Gateway key
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("");
console.log("  Lattik Studio needs a Vercel AI Gateway key for the chat agent.");
console.log("  Get one from: https://vercel.com/dashboard/ai-gateway");
console.log("");
const gatewayKey = await rl.question("  AI_GATEWAY_API_KEY (enter to skip): ");
rl.close();

// Keys we can safely generate locally. AUTH_SECRET uses base64 per NextAuth
// convention; the rest are 32-byte hex per the comments in .env.example.
const autoFilled = {
  ...(gatewayKey.trim() && { AI_GATEWAY_API_KEY: gatewayKey.trim() }),
  AUTH_SECRET: randomBytes(32).toString("base64"),
  GITEA_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  LATTIK_API_TOKEN: randomBytes(32).toString("hex"),
  TASK_AGENT_SECRET: randomBytes(32).toString("hex"),
  CRON_SECRET: randomBytes(32).toString("hex"),
};

let env = readFileSync(EXAMPLE_PATH, "utf8");
const filled = [];
for (const [key, value] of Object.entries(autoFilled)) {
  const re = new RegExp(`^${key}=$`, "m");
  if (re.test(env)) {
    env = env.replace(re, `${key}=${value}`);
    filled.push(key);
  }
}

writeFileSync(ENV_PATH, env);

// Also create apps/agent-worker/.env. Per-agent tokens (LATTIK_AGENT_TOKENS)
// are minted by `agent-tokens:bootstrap` after the DB is seeded — see
// scripts/bootstrap.sh. This step only lays down the API URL so the file
// exists when the token-bootstrap step appends to it.
if (!existsSync(AGENT_WORKER_ENV_PATH)) {
  // Use plain http://localhost:3737 — Node's fetch under tsx has trouble
  // trusting the portless self-signed cert on https://lattik-studio.dev,
  // even with `--use-system-ca`. localhost is the same web dev server,
  // just bypassing TLS. In-cluster workers use host.docker.internal:3737
  // (set by lib/kube.ts when the pod manifest is generated).
  writeFileSync(
    AGENT_WORKER_ENV_PATH,
    `TASK_API_URL=http://localhost:3737\n`,
  );
}

// And apps/agent-service/.env. Just a copy of the checked-in
// .env.example — agent-specific overrides only (PORT, dev bypass flags).
// Shared creds come from apps/web/.env at runtime via with-env.mjs.
if (!existsSync(AGENT_SERVICE_ENV_PATH) && existsSync(AGENT_SERVICE_ENV_EXAMPLE)) {
  copyFileSync(AGENT_SERVICE_ENV_EXAMPLE, AGENT_SERVICE_ENV_PATH);
}

console.log("");
console.log(
  "[env:bootstrap] Created apps/web/.env, apps/agent-worker/.env, apps/agent-service/.env",
);
if (filled.length > 0) {
  console.log("[env:bootstrap] Auto-configured:");
  for (const key of filled) console.log(`              - ${key}`);
}
if (!gatewayKey.trim()) {
  console.log("");
  console.log("[env:bootstrap] AI_GATEWAY_API_KEY was skipped — chat agent won't work");
  console.log("              until you add it to apps/web/.env");
}
