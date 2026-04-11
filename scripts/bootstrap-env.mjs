#!/usr/bin/env node
// Creates apps/web/.env from apps/web/.env.example on first run, auto-filling
// any secrets that don't require external services (AUTH_SECRET, webhook
// secrets, API tokens). Fields that require human action (Google OAuth, Vercel
// AI Gateway key) stay blank so the user fills them in before `pnpm dev`.
//
// Idempotent: if apps/web/.env already exists, this is a no-op. Never
// overwrites an existing file — safe to run on every `pnpm dev:up`.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = resolve(SCRIPT_DIR, "../apps/web/.env.example");
const ENV_PATH = resolve(SCRIPT_DIR, "../apps/web/.env");

if (existsSync(ENV_PATH)) {
  console.log("[env:bootstrap] apps/web/.env already exists — skipping.");
  process.exit(0);
}

if (!existsSync(EXAMPLE_PATH)) {
  console.error("[env:bootstrap] apps/web/.env.example not found — cannot bootstrap.");
  process.exit(1);
}

// Keys we can safely generate locally. AUTH_SECRET uses base64 per NextAuth
// convention; the rest are 32-byte hex per the comments in .env.example.
const autoFilled = {
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

console.log("[env:bootstrap] Created apps/web/.env from .env.example");
if (filled.length > 0) {
  console.log("[env:bootstrap] Auto-generated secrets:");
  for (const key of filled) console.log(`              - ${key}`);
}
console.log("[env:bootstrap] You still need to fill these in manually:");
console.log("              - AI_GATEWAY_API_KEY  (Vercel dashboard)");
console.log("              - AUTH_GOOGLE_ID      (Google Cloud Console)");
console.log("              - AUTH_GOOGLE_SECRET  (Google Cloud Console)");
