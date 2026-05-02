/**
 * `start_logger_writer` — render and apply the per-table logger-writer
 * Deployment manifest. Idempotent: re-applying with new replica count
 * (after a partition bump) triggers a rolling restart.
 *
 * Replica count auto-tracks the topic's partition count — we query Kafka
 * admin for `logger.<table>` and use that. Single source of truth: bump
 * partitions, re-fire the webhook, replicas follow automatically.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tool, zodSchema } from "ai";
import { Kafka } from "kafkajs";
import { applyManifest, waitForDeploymentAvailable } from "./lib/kube.js";
import { toolOutputSchema } from "./shared.js";

const KAFKA_BROKERS = (
  process.env.KAFKA_BROKERS ?? "kafka.kafka:9092"
).split(",");

// Walk up: apps/agent-worker/src/tools/ → repo root.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "../../../..");
const REPO_ROOT = process.env.LATTIK_REPO_ROOT ?? DEFAULT_REPO_ROOT;
const TEMPLATE_PATH = resolve(
  REPO_ROOT,
  "k8s/logger-writer/deployment-template.yaml",
);
const NAMESPACE = "workloads";
const WAIT_TIMEOUT_SECONDS = 120;

const outputSchema = toolOutputSchema(
  z.object({
    deployment: z.string().optional(),
    namespace: z.string().optional(),
    replicas: z.number().int().optional(),
    note: z.string().optional(),
  }),
);
type Output = z.infer<typeof outputSchema>;

function safeName(tableName: string): string {
  // k8s names: lowercase alphanumerics + '-', max 63 chars.
  return tableName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 53); // leave room for the `logger-writer-` prefix
}

async function getPartitionCount(topic: string): Promise<number> {
  const kafka = new Kafka({
    clientId: "lattik-agent-worker",
    brokers: KAFKA_BROKERS,
  });
  const admin = kafka.admin();
  try {
    await admin.connect();
    const meta = await admin.fetchTopicMetadata({ topics: [topic] });
    const t = meta.topics.find((x) => x.name === topic);
    if (!t) {
      throw new Error(`topic ${topic} not found in metadata`);
    }
    return t.partitions.length;
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`unknown template variable {{${key}}}`);
    }
    return vars[key];
  });
}

export const startLoggerWriterTool = tool({
  description:
    "Apply the per-table Kafka→Iceberg logger-writer Deployment for a Logger Table. Replicas auto-track the Kafka topic's partition count. Idempotent — re-apply triggers a rolling restart with the latest schema/partition count. Returns `{ ok, deployment, namespace, replicas }`.",
  inputSchema: zodSchema(
    z.object({
      table_name: z
        .string()
        .min(1)
        .describe(
          "Logger table name in `<schema>.<table>` form, e.g. `ingest.click_events`.",
        ),
    }),
  ),
  outputSchema: zodSchema(outputSchema),
  execute: async (input: { table_name: string }): Promise<Output> => {
    const topic = `logger.${input.table_name}`;
    let replicas: number;
    try {
      replicas = await getPartitionCount(topic);
    } catch (err) {
      return {
        ok: false,
        error: `failed to query Kafka admin for topic ${topic}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const tableSafe = safeName(input.table_name);
    const deploymentName = `logger-writer-${tableSafe}`;

    let template: string;
    try {
      template = await readFile(TEMPLATE_PATH, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `template not readable at ${TEMPLATE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let manifest: string;
    try {
      manifest = renderTemplate(template, {
        TABLE_NAME: input.table_name,
        TABLE_NAME_SAFE: tableSafe,
        REPLICAS: String(replicas),
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      await applyManifest(manifest);
    } catch (err) {
      return {
        ok: false,
        error: `kubectl apply failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      await waitForDeploymentAvailable(NAMESPACE, deploymentName, WAIT_TIMEOUT_SECONDS);
    } catch (err) {
      return {
        ok: false,
        error: `Deployment ${deploymentName} did not become Available within ${WAIT_TIMEOUT_SECONDS}s: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      ok: true,
      deployment: deploymentName,
      namespace: NAMESPACE,
      replicas,
    };
  },
});
