/**
 * `create_kafka_topic` — create the Kafka topic the ingest service produces
 * envelopes to for a Logger Table. Topic name is `logger.<table_name>`,
 * matching `apps/ingest/main.go`.
 *
 * Idempotent: if the topic exists, succeed.
 *
 * Ported from `apps/agent-worker/src/tools/create-kafka-topic.ts` as part
 * of the agent-worker → Vercel Workflow migration. Behavior identical.
 * The `KAFKA_BROKERS` default differs at the env layer — workers running
 * inside kind hit `kafka.kafka:9092` (in-cluster DNS); agent-service
 * runs on the host and hits `localhost:9094` (NodePort). Set via env.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import { Kafka, type ITopicConfig } from "kafkajs";
import { toolOutputSchema } from "./shared";

const outputSchema = toolOutputSchema(
  z.object({
    topic: z.string().optional(),
    created: z.boolean().optional(),
    partitions: z.number().int().optional(),
    replication_factor: z.number().int().optional(),
    note: z.string().optional(),
  }),
);
type Output = z.infer<typeof outputSchema>;

const KAFKA_BROKERS = (
  process.env.KAFKA_BROKERS ?? "localhost:9094"
).split(",");

const TOPIC_NUM_PARTITIONS = parseInt(
  process.env.LATTIK_TOPIC_NUM_PARTITIONS ?? "1",
  10,
);
const TOPIC_REPLICATION_FACTOR = parseInt(
  process.env.LATTIK_TOPIC_REPLICATION_FACTOR ?? "1",
  10,
);
const TOPIC_RETENTION_MS = parseInt(
  process.env.LATTIK_TOPIC_RETENTION_MS ?? `${7 * 24 * 60 * 60 * 1000}`,
  10,
);

export const createKafkaTopicTool = tool({
  description:
    "Create the Kafka topic for a Logger Table. The topic name is `logger.<table_name>` and the ingest service writes envelopes there. Idempotent — succeeds if the topic already exists. Returns `{ ok, topic, created, ... }`.",
  inputSchema: zodSchema(
    z.object({
      table_name: z
        .string()
        .min(1)
        .describe(
          "Logger table name in `<schema>.<table>` form, e.g. `ingest.click_events`",
        ),
    }),
  ),
  outputSchema: zodSchema(outputSchema),
  execute: async (input: { table_name: string }): Promise<Output> => {
    const topicName = `logger.${input.table_name}`;
    const kafka = new Kafka({
      clientId: "lattik-agent-service",
      brokers: KAFKA_BROKERS,
    });
    const admin = kafka.admin();

    try {
      await admin.connect();
      const existing = await admin.listTopics();
      if (existing.includes(topicName)) {
        return {
          ok: true,
          topic: topicName,
          created: false,
          note: "already existed",
        };
      }

      const topicConfig: ITopicConfig = {
        topic: topicName,
        numPartitions: TOPIC_NUM_PARTITIONS,
        replicationFactor: TOPIC_REPLICATION_FACTOR,
        configEntries: [
          { name: "retention.ms", value: String(TOPIC_RETENTION_MS) },
        ],
      };
      const created = await admin.createTopics({ topics: [topicConfig] });
      return {
        ok: true,
        topic: topicName,
        created,
        partitions: TOPIC_NUM_PARTITIONS,
        replication_factor: TOPIC_REPLICATION_FACTOR,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await admin.disconnect().catch(() => {});
    }
  },
});
