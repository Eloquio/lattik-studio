#!/usr/bin/env node
// Printed at the end of `pnpm dev:up` to tell the user what they still need
// to do by hand: fill in the manual .env fields, start portless, and start
// the Next.js dev server.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(SCRIPT_DIR, "../apps/web/.env");

const manualKeys = [
  ["AI_GATEWAY_API_KEY", "Vercel AI Gateway"],
  ["AUTH_GOOGLE_ID", "Google Cloud Console"],
  ["AUTH_GOOGLE_SECRET", "Google Cloud Console"],
];

const missing = [];
if (existsSync(ENV_PATH)) {
  const env = readFileSync(ENV_PATH, "utf8");
  for (const [key, source] of manualKeys) {
    const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (!m || m[1].trim() === "") missing.push([key, source]);
  }
}

const line = (s = "") => console.log(s);
line();
line("---------------------------------------------------");
line("  Lattik Studio dev stack is up");
line("---------------------------------------------------");
line();

if (missing.length > 0) {
  line("  apps/web/.env still needs these filled in:");
  for (const [key, source] of missing) line(`    - ${key.padEnd(22)}(${source})`);
  line();
}

line("  Next steps:");
line("    1. In a separate terminal:  portless proxy start --tld dev");
line("    2. In a separate terminal:  pnpm dev");
line("    3. Open:                    https://lattik-studio.dev");
line();
