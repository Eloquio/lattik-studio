import { Kafka, type Admin } from "kafkajs";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "kafka.kafka:9092").split(
  ","
);

const kafka = new Kafka({
  clientId: "lattik-studio",
  brokers: KAFKA_BROKERS,
});

// Lazily-connected singleton. Webhook fan-outs that create N topics for one
// merged PR were previously reopening the TCP+SASL handshake N times in
// series. The admin client is process-local and safe to reuse across calls;
// connectPromise dedupes concurrent first connections.
let adminClient: Admin | null = null;
let connectPromise: Promise<void> | null = null;

async function getAdmin(): Promise<Admin> {
  if (adminClient) return adminClient;
  if (!connectPromise) {
    adminClient = kafka.admin();
    connectPromise = adminClient.connect().catch((err) => {
      // Failed connect — drop the singleton so the next caller retries
      // cleanly instead of inheriting a half-connected client.
      adminClient = null;
      connectPromise = null;
      throw err;
    });
  }
  await connectPromise;
  if (!adminClient) {
    throw new Error("kafka admin connect raced to null");
  }
  return adminClient;
}

/**
 * Derives the Kafka topic name from a Logger Table name.
 * e.g. "ingest.click_events" → "logger.ingest.click_events"
 */
export function topicName(tableName: string): string {
  return `logger.${tableName}`;
}

/** Parse a retention string like "30d" into milliseconds. */
function retentionMs(retention: string): number {
  const match = retention.match(/^(\d+)d$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000; // default 30 days
  return parseInt(match[1]!, 10) * 24 * 60 * 60 * 1000;
}

/**
 * Creates a Kafka topic for a merged Logger Table.
 * Idempotent — does nothing if the topic already exists.
 */
export async function createLoggerTopic(
  tableName: string,
  retention: string = "30d"
): Promise<void> {
  const admin = await getAdmin();
  await admin.createTopics({
    topics: [
      {
        topic: topicName(tableName),
        numPartitions: 1,
        replicationFactor: 1,
        configEntries: [
          {
            name: "retention.ms",
            value: String(retentionMs(retention)),
          },
        ],
      },
    ],
  });
}
