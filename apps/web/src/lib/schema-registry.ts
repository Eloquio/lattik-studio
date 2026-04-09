const SCHEMA_REGISTRY_URL =
  process.env.SCHEMA_REGISTRY_URL ?? "http://schema-registry.schema-registry:8081";

/**
 * Registers a Protobuf schema for a Logger Table's payload in the
 * Confluent Schema Registry. The subject follows the TopicNameStrategy:
 * `<topic>-value`, e.g. `logger.ingest.click_events-value`.
 *
 * Idempotent — re-registering an identical schema returns the existing ID.
 */
export async function registerPayloadSchema(
  topic: string,
  protoContent: string,
): Promise<{ id: number }> {
  const subject = `${topic}-value`;
  const response = await fetch(
    `${SCHEMA_REGISTRY_URL}/subjects/${encodeURIComponent(subject)}/versions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/vnd.schemaregistry.v1+json" },
      body: JSON.stringify({
        schemaType: "PROTOBUF",
        schema: protoContent,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Schema registration failed for ${subject}: ${response.status} ${body}`,
    );
  }
  return (await response.json()) as { id: number };
}
