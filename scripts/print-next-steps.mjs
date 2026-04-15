#!/usr/bin/env node
// Printed at the end of `pnpm dev:up` to remind the user to start portless
// and the Next.js dev server.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(SCRIPT_DIR, "../apps/web/.env");

let gatewayMissing = false;
if (existsSync(ENV_PATH)) {
  const env = readFileSync(ENV_PATH, "utf8");
  const m = env.match(/^AI_GATEWAY_API_KEY=(.*)$/m);
  gatewayMissing = !m || m[1].trim() === "";
}

const line = (s = "") => console.log(s);
line();
line("---------------------------------------------------");
line("  Lattik Studio dev stack is up");
line("---------------------------------------------------");
line();

if (gatewayMissing) {
  line("  AI_GATEWAY_API_KEY is not set — chat agent won't work.");
  line("  Add it to apps/web/.env (get one from https://vercel.com/ai-gateway)");
  line();
}

line("  Next steps:");
line("    1. In a separate terminal:  sudo portless proxy start --tld dev");
line("    2. In a separate terminal:  pnpm dev");
line("    3. Open:                    https://lattik-studio.dev");
line();
