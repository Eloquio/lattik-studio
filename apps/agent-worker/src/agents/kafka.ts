/**
 * Kafka Agent — manages Kafka topics for Logger Tables.
 *
 * Tools: createTopic, describeTopic, listTopics, deleteTopic.
 * Uses Haiku for cheap, fast execution. The agent reads the task description
 * and done criteria, uses its tools to execute, verifies the criteria, and
 * reports back.
 */

import { ToolLoopAgent, zodSchema, gateway, stepCountIs } from "ai";
import { z } from "zod";
import { Kafka } from "kafkajs";

const KAFKA_BROKERS = (
  process.env.KAFKA_BROKERS ?? "kafka.kafka:9092"
).split(",");

const kafka = new Kafka({
  clientId: "kafka-agent",
  brokers: KAFKA_BROKERS,
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function retentionMs(retention: string): number {
  const match = retention.match(/^(\d+)d$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  return parseInt(match[1]!, 10) * 24 * 60 * 60 * 1000;
}

const tools = {
  createTopic: {
    description:
      "Create a Kafka topic. Idempotent — does nothing if the topic already exists.",
    inputSchema: zodSchema(
      z.object({
        topic: z.string().describe("Topic name (e.g. 'logger.click_events')"),
        numPartitions: z.number().default(1),
        retentionDays: z
          .string()
          .default("30d")
          .describe("Retention period (e.g. '30d', '7d')"),
      })
    ),
    execute: async (input: {
      topic: string;
      numPartitions: number;
      retentionDays: string;
    }) => {
      const admin = kafka.admin();
      try {
        await admin.connect();
        const created = await admin.createTopics({
          topics: [
            {
              topic: input.topic,
              numPartitions: input.numPartitions,
              replicationFactor: 1,
              configEntries: [
                {
                  name: "retention.ms",
                  value: String(retentionMs(input.retentionDays)),
                },
              ],
            },
          ],
        });
        return { created, topic: input.topic };
      } finally {
        await admin.disconnect();
      }
    },
  },

  describeTopic: {
    description:
      "Describe a Kafka topic — returns partition count, replication factor, and config entries like retention.ms. Use this to verify a topic exists and has the correct configuration.",
    inputSchema: zodSchema(
      z.object({
        topic: z.string().describe("Topic name to describe"),
      })
    ),
    execute: async (input: { topic: string }) => {
      const admin = kafka.admin();
      try {
        await admin.connect();
        const metadata = await admin.fetchTopicMetadata({
          topics: [input.topic],
        });
        const config = await admin.describeConfigs({
          includeSynonyms: false,
          resources: [
            { type: 2 /* TOPIC */, name: input.topic, configNames: ["retention.ms"] },
          ],
        });
        const topicMeta = metadata.topics[0];
        const retentionEntry = config.resources[0]?.configEntries?.find(
          (e) => e.configName === "retention.ms"
        );
        return {
          topic: input.topic,
          exists: true,
          partitions: topicMeta?.partitions.length ?? 0,
          retentionMs: retentionEntry?.configValue ?? "unknown",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("UnknownTopicOrPartition") || message.includes("does not exist")) {
          return { topic: input.topic, exists: false };
        }
        throw err;
      } finally {
        await admin.disconnect();
      }
    },
  },

  listTopics: {
    description: "List all Kafka topics.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const admin = kafka.admin();
      try {
        await admin.connect();
        const topics = await admin.listTopics();
        return { topics };
      } finally {
        await admin.disconnect();
      }
    },
  },

  deleteTopic: {
    description: "Delete a Kafka topic. Use with caution.",
    inputSchema: zodSchema(
      z.object({
        topic: z.string().describe("Topic name to delete"),
      })
    ),
    execute: async (input: { topic: string }) => {
      const admin = kafka.admin();
      try {
        await admin.connect();
        await admin.deleteTopics({ topics: [input.topic] });
        return { deleted: true, topic: input.topic };
      } finally {
        await admin.disconnect();
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

const instructions = `You are the Kafka agent. Your job is to execute Kafka-related tasks and verify the done criteria.

You will receive a task with a description and done criteria. Execute the task using your tools, then verify the done criteria is met.

## How to work
1. Read the task description to understand what needs to be done.
2. Use your tools to execute the task (e.g. createTopic, describeTopic).
3. After execution, verify the done criteria using describeTopic or listTopics.
4. Report the result.

## Tools
- createTopic: Create a Kafka topic with specified partitions and retention.
- describeTopic: Check if a topic exists and its configuration (use for verification).
- listTopics: List all topics.
- deleteTopic: Delete a topic.

Be concise. Execute, verify, done.`;

export function createKafkaAgent(task: {
  description: string;
  doneCriteria: string;
}) {
  return new ToolLoopAgent({
    id: "kafka",
    model: gateway("anthropic/claude-haiku-4.5"),
    instructions: `${instructions}\n\n## Current Task\n**Description:** ${task.description}\n**Done Criteria:** ${task.doneCriteria}`,
    tools,
    stopWhen: stepCountIs(5),
  });
}
