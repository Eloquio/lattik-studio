import { getWritable } from "workflow";

// Spike 2: prove that a workflow step can stream chunks via getWritable() and
// that a route handler can read them through `run.readable` / `run.getReadable
// ({ startIndex })`. The step deliberately delays between chunks so a second
// HTTP client can reattach mid-flight and verify it picks up from a cursor.

const TICK_COUNT = 5;
const TICK_DELAY_MS = 400;

async function emitTicksStep() {
  "use step";
  const writable = getWritable<string>();
  const writer = writable.getWriter();
  try {
    for (let i = 0; i < TICK_COUNT; i++) {
      await writer.write(`tick ${i}`);
      if (i < TICK_COUNT - 1) {
        await new Promise((resolve) => setTimeout(resolve, TICK_DELAY_MS));
      }
    }
  } finally {
    await writer.close();
  }
  return TICK_COUNT;
}

export async function streamingWorkflow() {
  "use workflow";
  const written = await emitTicksStep();
  return { ticksWritten: written };
}
