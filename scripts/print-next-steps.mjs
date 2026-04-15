#!/usr/bin/env node
// Printed at the end of `pnpm dev:up` to remind the user to start the
// Next.js dev server.

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
line("  Lattik Studio prerequisites ready");
line("---------------------------------------------------");
line();

if (gatewayMissing) {
  line("  AI_GATEWAY_API_KEY is not set — chat agent won't work.");
  line("  Add it to apps/web/.env (get one from https://vercel.com/ai-gateway)");
  line();
}

line("  Next steps:");
line("    1. Start the dev server:  pnpm dev");
line("    2. Open:                  https://lattik-studio.dev");
line();
line("  pnpm dev will start the web UI immediately and bring up");
line("  remaining services (gitea, trino, kafka, etc.) in the background.");
line("  Run  tail -f .dev-services.log  to follow their progress.");
line();
