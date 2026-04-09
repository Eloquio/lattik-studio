import { fromBinary } from "@bufbuild/protobuf";
import { EnvelopeSchema } from "../gen/lattik/logger/v1/envelope_pb.js";
import type { Transport } from "../types.js";

/**
 * Decodes the protobuf Envelope and logs it as JSON to stdout.
 * Useful for local development and debugging.
 */
export class ConsoleTransport implements Transport {
  async send(data: Uint8Array): Promise<void> {
    const envelope = fromBinary(EnvelopeSchema, data);
    console.log(
      JSON.stringify({
        table: envelope.table,
        eventId: envelope.eventId,
        eventTimestamp: envelope.eventTimestamp,
        payloadBytes: envelope.payload.length,
      }),
    );
  }
}
