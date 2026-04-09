import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { create, toBinary } from "@bufbuild/protobuf";
import { createEnvelope } from "./envelope.js";
import type { LoggerClientConfig, Transport } from "./types.js";

export class LoggerClient<T extends DescMessage> {
  readonly table: string;
  readonly schema: T;
  private transport: Transport;

  constructor(config: LoggerClientConfig<T>) {
    this.table = config.table;
    this.schema = config.schema;
    this.transport = config.transport;
  }

  /**
   * Log an event. The payload is serialized to protobuf bytes,
   * wrapped in an Envelope, and sent via the transport.
   */
  async log(payload: MessageShape<T>): Promise<void> {
    const message = create(this.schema, payload);
    const payloadBytes = toBinary(this.schema, message);
    const envelopeBytes = createEnvelope(this.table, payloadBytes);
    await this.transport.send(envelopeBytes);
  }

  /** Replace the transport at runtime. */
  setTransport(transport: Transport): void {
    this.transport = transport;
  }
}

/** Create a type-safe LoggerClient for a specific Logger Table. */
export function createLoggerClient<T extends DescMessage>(
  config: LoggerClientConfig<T>,
): LoggerClient<T> {
  return new LoggerClient(config);
}
