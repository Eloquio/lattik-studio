import { create, toBinary } from "@bufbuild/protobuf";
import {
  EnvelopeSchema,
  type Envelope,
} from "./gen/lattik/logger/v1/envelope_pb.js";

/** Creates and serializes an Envelope to protobuf bytes. */
export function createEnvelope(
  table: string,
  payloadBytes: Uint8Array,
): Uint8Array {
  const envelope = create(EnvelopeSchema, {
    table,
    eventId: crypto.randomUUID(),
    eventTimestamp: new Date().toISOString(),
    payload: payloadBytes,
  });
  return toBinary(EnvelopeSchema, envelope);
}

export { EnvelopeSchema, type Envelope };
