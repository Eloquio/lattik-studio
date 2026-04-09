import type { Transport } from "../types.js";

export interface HttpTransportConfig {
  /** Ingestion service URL, e.g. "https://ingest.lattik.dev/v1/events". */
  url: string;
  /** Additional headers (e.g. auth tokens). */
  headers?: Record<string, string>;
}

/**
 * Sends the serialized protobuf Envelope to an HTTP ingestion endpoint.
 * Content-Type is application/x-protobuf.
 */
export class HttpTransport implements Transport {
  private url: string;
  private headers: Record<string, string>;

  constructor(config: HttpTransportConfig) {
    this.url = config.url;
    this.headers = config.headers ?? {};
  }

  async send(data: Uint8Array): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        ...this.headers,
      },
      body: data as BodyInit,
    });
    if (!response.ok) {
      throw new Error(
        `Ingestion failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}
