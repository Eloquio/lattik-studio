#!/usr/bin/env node
// Reports the status of every Lattik dev-stack service.
// Usage: pnpm dev:status

import { execFileSync } from "node:child_process";
import net from "node:net";

// Services checked via kubectl pod readiness.
const K8S_SERVICES = [
  { namespace: "postgres", label: "app=postgres", name: "PostgreSQL", endpoint: "localhost:5432" },
  { namespace: "gitea", label: "app=gitea", name: "Gitea", endpoint: "http://localhost:3300" },
  { namespace: "minio", label: "app=minio", name: "MinIO", endpoint: "http://localhost:9000" },
  { namespace: "iceberg", label: "app=iceberg-rest", name: "Iceberg REST", endpoint: "localhost:8181" },
  { namespace: "trino", label: "app=trino", name: "Trino", endpoint: "http://localhost:8080" },
  { namespace: "kafka", label: "app=kafka", name: "Kafka", endpoint: "localhost:9094" },
  { namespace: "schema-registry", label: "app=schema-registry", name: "Schema Registry", endpoint: "http://localhost:8081" },
  { namespace: "workloads", label: "app=ingest", name: "Ingest", endpoint: "localhost:8090" },
  { namespace: "spark-operator", label: "app.kubernetes.io/name=spark-operator", name: "Spark Operator", endpoint: null },
  { namespace: "airflow", label: "app=airflow-api-server", name: "Airflow", endpoint: "http://localhost:8088" },
];

function podReady(namespace, label) {
  try {
    const out = execFileSync(
      "kubectl",
      ["-n", namespace, "get", "pod", "-l", label, "-o", "jsonpath={.items[0].status.conditions[?(@.type=='Ready')].status}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.trim() === "True";
  } catch {
    return false;
  }
}

function clusterExists() {
  try {
    const out = execFileSync("kind", ["get", "clusters"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.split("\n").some((l) => l.trim() === "lattik");
  } catch {
    return false;
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: "127.0.0.1" });
    sock.setTimeout(500);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------

console.log("");
console.log("  Lattik dev stack status");
console.log("  ───────────────────────");
console.log("");

// kind cluster
const cluster = clusterExists();
if (cluster) {
  console.log("  ✓  kind cluster (lattik)");
} else {
  console.log("  ✗  kind cluster (lattik) — not found");
}

// k8s services
if (cluster) {
  for (const svc of K8S_SERVICES) {
    const ready = podReady(svc.namespace, svc.label);
    const suffix = svc.endpoint ? `  ${svc.endpoint}` : "";
    if (ready) {
      console.log(`  ✓  ${svc.name}${suffix}`);
    } else {
      console.log(`  ✗  ${svc.name} — not ready`);
    }
  }
}

console.log("");

// portless / Next.js — check via TCP
const nextUp = await checkPort(3000);
if (nextUp) {
  console.log("  ✓  Next.js dev server  https://lattik-studio.dev");
} else {
  console.log("  ✗  Next.js dev server — not running");
}

const portlessUp = await checkPort(443);
if (portlessUp) {
  console.log("  ✓  portless proxy (port 443)");
} else {
  console.log("  ✗  portless proxy — not running  (sudo portless proxy start --tld dev)");
}

console.log("");
