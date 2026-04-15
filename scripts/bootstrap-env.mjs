#!/usr/bin/env node
// Creates apps/web/.env from apps/web/.env.example and apps/agent-worker/.env
// on first run, auto-filling secrets and prompting for the AI Gateway key.
// Idempotent: if both .env files already exist, this is a no-op.

import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = resolve(SCRIPT_DIR, "../apps/web/.env.example");
const ENV_PATH = resolve(SCRIPT_DIR, "../apps/web/.env");

const AGENT_WORKER_ENV_PATH = resolve(SCRIPT_DIR, "../apps/agent-worker/.env");

if (existsSync(ENV_PATH) && existsSync(AGENT_WORKER_ENV_PATH)) {
  console.log("[env:bootstrap] apps/web/.env already exists — skipping.");
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

// Also create apps/agent-worker/.env with the shared TASK_AGENT_SECRET
if (!existsSync(AGENT_WORKER_ENV_PATH)) {
  const agentSecret = autoFilled.TASK_AGENT_SECRET;
  writeFileSync(AGENT_WORKER_ENV_PATH, `TASK_AGENT_SECRET=${agentSecret}\n`);
}

console.log("");
console.log("[env:bootstrap] Created apps/web/.env and apps/agent-worker/.env");
if (filled.length > 0) {
  console.log("[env:bootstrap] Auto-configured:");
  for (const key of filled) console.log(`              - ${key}`);
}
if (!gatewayKey.trim()) {
  console.log("");
  console.log("[env:bootstrap] AI_GATEWAY_API_KEY was skipped — chat agent won't work");
  console.log("              until you add it to apps/web/.env");
}
console.log("");
console.log("[env:bootstrap] Auth: sign in with admin/admin (no Google OAuth needed)");
