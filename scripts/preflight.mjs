#!/usr/bin/env node
// Preflight checks for Lattik Studio local development.
// Validates that all required tools, resources, and ports are available
// before starting the dev stack. Run automatically by `pnpm dev:up`.

import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import net from "node:net";

const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_PNPM_MAJOR = 10;
const MIN_RAM_GB = 8;
const WARN_RAM_GB = 12;
const MIN_DISK_GB = 20;

// Ports that must be free for the full dev stack.
// portless (443) is checked separately as a warning since it runs before dev:up.
const REQUIRED_PORTS = [
  { port: 3000, label: "Next.js dev server" },
  { port: 3300, label: "Gitea" },
  { port: 5432, label: "PostgreSQL" },
  { port: 8080, label: "Trino" },
  { port: 8088, label: "Airflow" },
  { port: 9000, label: "MinIO S3 API" },
  { port: 9001, label: "MinIO console" },
  { port: 9094, label: "Kafka" },
];

let hasError = false;
let hasWarning = false;

function pass(msg) {
  console.log(`  ✓  ${msg}`);
}

function warn(msg) {
  hasWarning = true;
  console.log(`  ⚠  ${msg}`);
}

function fail(msg, fix) {
  hasError = true;
  console.log(`  ✗  ${msg}`);
  if (fix) console.log(`     → ${fix}`);
}

function commandExists(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getCommandVersion(cmd, args = ["--version"]) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------

console.log("");
console.log("  Preflight checks");
console.log("  ────────────────");
console.log("");

// --- Tools ---

// Docker
if (!commandExists("docker")) {
  fail("Docker is not installed", "Install from https://docs.docker.com/get-docker/");
} else {
  try {
    execFileSync("docker", ["info"], { stdio: "pipe" });
    pass("Docker is running");
  } catch {
    fail("Docker is installed but not running", "Start Docker Desktop");
  }
}

// kind
if (!commandExists("kind")) {
  fail("kind is not installed", "brew install kind  (or see https://kind.sigs.k8s.io/)");
} else {
  pass("kind is installed");
}

// helm
if (!commandExists("helm")) {
  fail("helm is not installed", "brew install helm  (or see https://helm.sh/docs/intro/install/)");
} else {
  pass("helm is installed");
}

// kubectl
if (!commandExists("kubectl")) {
  fail("kubectl is not installed", "brew install kubectl  (or see https://kubernetes.io/docs/tasks/tools/)");
} else {
  pass("kubectl is installed");
}

// Node.js version
const nodeMajor = parseInt(process.version.slice(1), 10);
if (nodeMajor < REQUIRED_NODE_MAJOR) {
  fail(`Node.js ${process.version} — requires v${REQUIRED_NODE_MAJOR}+`, "Install Node.js 22+ from https://nodejs.org/");
} else {
  pass(`Node.js ${process.version}`);
}

// pnpm version
const pnpmVersion = getCommandVersion("pnpm");
if (!pnpmVersion) {
  fail("pnpm is not installed", "npm install -g pnpm");
} else {
  const pnpmMajor = parseInt(pnpmVersion.replace(/^v?/, ""), 10);
  if (pnpmMajor < REQUIRED_PNPM_MAJOR) {
    fail(`pnpm ${pnpmVersion} — requires v${REQUIRED_PNPM_MAJOR}+`, "npm install -g pnpm@latest");
  } else {
    pass(`pnpm ${pnpmVersion}`);
  }
}

// portless
if (!commandExists("portless")) {
  warn("portless is not installed — HTTPS proxy won't work");
  console.log("     → npm install -g portless");
} else {
  pass("portless is installed");
}

// --- Resources ---

console.log("");

const totalGB = totalmem() / 1024 ** 3;
if (totalGB < MIN_RAM_GB) {
  fail(`${totalGB.toFixed(1)} GB RAM — requires ${MIN_RAM_GB}+ GB`, "Close other apps or increase Docker Desktop memory");
} else if (totalGB < WARN_RAM_GB) {
  warn(`${totalGB.toFixed(1)} GB RAM — ${WARN_RAM_GB}+ GB recommended for the full stack`);
} else {
  pass(`${totalGB.toFixed(1)} GB RAM`);
}

try {
  const { bavail, bsize } = statfsSync(".");
  const freeGB = (bavail * bsize) / 1024 ** 3;
  if (freeGB < MIN_DISK_GB) {
    fail(`${freeGB.toFixed(1)} GB free disk — requires ${MIN_DISK_GB}+ GB`, "Free up disk space");
  } else {
    pass(`${freeGB.toFixed(1)} GB free disk`);
  }
} catch {
  warn("Could not check disk space");
}

// --- Ports ---

console.log("");

const portResults = await Promise.all(
  REQUIRED_PORTS.map(async ({ port, label }) => {
    const free = await checkPort(port);
    return { port, label, free };
  }),
);

const busyPorts = portResults.filter((r) => !r.free);
if (busyPorts.length === 0) {
  pass("All required ports are free");
} else {
  for (const { port, label } of busyPorts) {
    fail(`Port ${port} (${label}) is in use`, `lsof -i :${port} to find the process`);
  }
}

// --- Result ---

console.log("");

if (hasError) {
  console.log("  Preflight failed — fix the issues above before continuing.");
  console.log("");
  process.exit(1);
}

if (hasWarning) {
  console.log("  Preflight passed with warnings.");
} else {
  console.log("  Preflight passed.");
}
console.log("");
