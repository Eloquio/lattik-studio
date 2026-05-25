#!/usr/bin/env node
// Generate src/workflows/dag-runner.template.generated.ts from
// src/workflows/dag-runner.template.js.
//
// Why: the runner.js source needs to (a) be ESLint/tsc/vitest-visible, and
// (b) reach the function bundle as a string at runtime. The original
// `readFileSync(new URL("./runner.template.js", import.meta.url))` approach
// works under Webpack + @vercel/nft (which traces static fs reads), but
// breaks under Turbopack — Next 16 Turbopack treats
// `new URL(..., import.meta.url)` as a module-resolution attempt rather
// than a traced asset read, and the workflow plugin's generated step route
// puts the call site at a path where `./dag-runner.template.js` does not
// exist.
//
// Inlining the contents into a generated `.ts` file with `export const
// RUNNER_TEMPLATE = "..."` removes the asset-resolution dependency
// entirely: every bundler in the pipeline (Turbopack, Webpack, the
// workflow plugin's own pre-bundler) handles a plain string export
// identically.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src/workflows/dag-runner.template.js");
const OUT = join(ROOT, "src/workflows/dag-runner.template.generated.ts");

const source = readFileSync(SRC, "utf8");

const banner = `// AUTO-GENERATED from src/workflows/dag-runner.template.js — do not edit by hand.
//
// Re-run \`pnpm build:runner-template\` to refresh; the predev / prebuild /
// pretest lifecycle scripts call it for you, so any normal pnpm workflow
// keeps this file in lockstep with the source.

`;

const body = `export const RUNNER_TEMPLATE: string = ${JSON.stringify(source)};\n`;

writeFileSync(OUT, banner + body);
console.log(
  `[build-runner-template] ${OUT} (${source.length} src chars → ${
    (banner + body).length
  } total bytes)`
);
