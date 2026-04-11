/**
 * Minimal JSON-line structured logger for route handlers.
 *
 * Emits one JSON object per call to stdout/stderr, with a consistent shape:
 *
 *   {"ts":"2026-04-11T20:05:00.123Z","level":"info","event":"lattik.commit","..."}
 *
 * Keeps the API intentionally small — no log levels, no transport config,
 * no context propagation. Next.js already captures console output into its
 * server logs; this just gives the entries a machine-parseable shape.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, data: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (event: string, data: Record<string, unknown> = {}) =>
    emit("info", event, data),
  warn: (event: string, data: Record<string, unknown> = {}) =>
    emit("warn", event, data),
  error: (event: string, data: Record<string, unknown> = {}) =>
    emit("error", event, data),
};
