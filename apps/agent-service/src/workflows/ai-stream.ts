import { getWritable } from "workflow";
import { streamText, gateway } from "ai";

// Spike 3: prove that an AI SDK `streamText` call can run inside a `'use step'`
// function and pipe its `textStream` into the workflow writable, so the same
// `run.getReadable({ startIndex })` reattach mechanism from Spike 2 works for
// real model output. The model + prompt are passed in as workflow inputs to
// keep the step reusable.

export interface AiStreamInput {
  modelId: string;
  prompt: string;
}

async function runStreamTextStep(input: AiStreamInput) {
  "use step";
  const { textStream } = streamText({
    model: gateway(input.modelId),
    prompt: input.prompt,
  });

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  let charCount = 0;
  try {
    for await (const chunk of textStream) {
      charCount += chunk.length;
      await writer.write(chunk);
    }
  } finally {
    await writer.close();
  }
  return { charCount };
}

export async function aiStreamWorkflow(input: AiStreamInput) {
  "use workflow";
  return runStreamTextStep(input);
}
