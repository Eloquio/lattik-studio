import { resolve } from "node:path";
import {
  ToolLoopAgent,
  gateway,
  stepCountIs,
  type Tool,
  type OnFinishEvent,
} from "ai";
import { getSkill } from "@eloquio/agent-harness";

// The harness's default skill directory resolves from its own package
// path, which works when the consumer runs from source (agent-worker
// runs via tsx). Nitropack bundles agent-service into `.output/server/`
// where that resolution lands somewhere meaningless. Override with the
// repo-root-relative path. The with-env wrapper launches the process
// with cwd = apps/agent-service, so two levels up is the workspace
// root.
const SKILLS_DIR = resolve(
  process.cwd(),
  "../../packages/agent-harness/skills",
);
import { createKafkaTopicTool } from "../agents/Executor/tools/create-kafka-topic.js";
import { emitLoggerProtoTool } from "../agents/Executor/tools/emit-logger-proto.js";
import { registerProtobufSchemaTool } from "../agents/Executor/tools/register-protobuf-schema.js";
import { createIcebergTableTool } from "../agents/Executor/tools/create-iceberg-table.js";
import { startLoggerWriterTool } from "../agents/Executor/tools/start-logger-writer.js";
import { createFinishSkillTool } from "../agents/Executor/tools/finish-skill.js";

/**
 * Skill-run workflow — agent-worker replacement.
 *
 * Today the agent-worker pod polls the run queue, claims a run, builds an
 * Executor agent for the run's skill, and runs it. This workflow does the
 * same job inside Vercel Workflow's runtime: HTTP-triggered (no polling),
 * one workflow per run, all step persistence handed to WDK.
 *
 * Slice 2 scope: the harness loads the skill from disk
 * (`packages/agent-harness/skills/<id>/SKILL.md`), and all five Executor
 * tools (kafka topic, proto, schema registry, iceberg, logger writer) are
 * wired into the agent. The previous slice's hard-coded instructions are
 * gone.
 *
 * Why a single 'use step' wrapping the whole agent loop instead of
 * per-tool steps like the chat workflow does:
 * - The post-merge skill's tools are explicitly idempotent (the SKILL.md
 *   calls this out for every tool: kafka topic create is idempotent,
 *   iceberg CREATE TABLE IF NOT EXISTS, kubectl apply, etc.). Replay-
 *   from-scratch on workflow retry is safe.
 * - One step is dramatically simpler than the chat-side per-tool wiring
 *   (which exists because chat tools stream UIMessageChunks back to a
 *   live client). Skill execution is headless — no client to stream to.
 *
 * If non-idempotent tools land in this catalog later, switch to the
 * per-tool-step pattern from `agent-loop.ts:runToolStep`.
 */

export interface SkillRunInput {
  runId: string;
  skillId: string;
  args: Record<string, unknown>;
}

export interface SkillRunResult {
  ok: boolean;
  runId: string;
  text?: string;
  finishReason?: string;
  toolCallCount?: number;
  error?: string;
}

// Static tool registry. Each entry maps a tool name (as it appears in a
// SKILL.md `tools:` list) to either a Tool instance (pure tools that
// don't need per-run context) or a factory that builds one given the
// run context. Names match the on-disk SKILL.md frontmatter exactly.
type ToolBuilder = Tool | ((ctx: SkillRunInput) => Tool);

const TOOL_REGISTRY: Record<string, ToolBuilder> = {
  create_kafka_topic: createKafkaTopicTool,
  emit_logger_proto: emitLoggerProtoTool,
  register_protobuf_schema: registerProtobufSchemaTool,
  create_iceberg_table: createIcebergTableTool,
  start_logger_writer: startLoggerWriterTool,
};

export async function runSkillWorkflow(
  input: SkillRunInput,
): Promise<SkillRunResult> {
  "use workflow";
  return runSkillStep(input);
}

async function runSkillStep(input: SkillRunInput): Promise<SkillRunResult> {
  "use step";

  let skill;
  try {
    skill = getSkill(input.skillId, "ExecutorAgent", { skillsDir: SKILLS_DIR });
  } catch (err) {
    return {
      ok: false,
      runId: input.runId,
      error: `Failed to load skill ${input.skillId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Resolve the skill's declared tool list against the registry. Drop
  // unregistered names with a warning — same lenient behavior as the
  // agent-worker's executor (loader preflight already warns at startup).
  const tools: Record<string, Tool> = {};
  for (const toolName of skill.frontmatter.tools) {
    const entry = TOOL_REGISTRY[toolName];
    if (!entry) {
      console.warn(
        `[skill-run] skill "${input.skillId}" declares unregistered tool "${toolName}" — dropping`,
      );
      continue;
    }
    tools[toolName] = typeof entry === "function" ? entry(input) : entry;
  }
  tools.finishSkill = createFinishSkillTool({
    runId: input.runId,
    doneChecks: skill.frontmatter.done,
  });

  let toolCallCount = 0;
  const onFinish = (event: OnFinishEvent) => {
    toolCallCount = event.steps.reduce(
      (n: number, s: { toolCalls?: unknown[] }) =>
        n + (s.toolCalls?.length ?? 0),
      0,
    );
  };

  const agent = new ToolLoopAgent({
    id: `Executor:${input.skillId}`,
    model: gateway(skill.frontmatter.model),
    instructions: skill.body,
    tools,
    stopWhen: stepCountIs(20),
    onFinish,
  });

  const argsBlock =
    Object.keys(input.args).length > 0
      ? `\n\nArgs (pass these to tool calls):\n${JSON.stringify(input.args, null, 2)}`
      : "";

  const prompt = `Run ${input.runId}.

Description: skill ${input.skillId}

Done when: the runbook in your instructions reports completion.${argsBlock}

Follow the runbook in your instructions, use the tools available to you, and call finishSkill exactly once when complete.`;

  try {
    const result = await agent.generate({ prompt });
    return {
      ok: true,
      runId: input.runId,
      text: result.text,
      finishReason: result.finishReason,
      toolCallCount,
    };
  } catch (err) {
    return {
      ok: false,
      runId: input.runId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
