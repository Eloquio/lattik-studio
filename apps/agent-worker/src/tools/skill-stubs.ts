/**
 * Per-skill tool stubs.
 *
 * Skills declare tools in their frontmatter (`tools: [http:post, s3:write, ...]`).
 * Real implementations land alongside each skill as it gets wired for production
 * use. Until then, these stubs log + succeed so the executor agent can run the
 * runbook end-to-end without the actual side effects firing.
 *
 * Add new ids to STUB_TOOL_IDS as they appear in real SKILL.md files.
 */

import { z } from "zod";
import { tool, zodSchema, type Tool } from "ai";

const STUB_TOOL_IDS = [
  "http:post",
  "s3:write",
  "kafka:write",
  "trino:query",
  "sr:register",
] as const;

export type StubToolId = (typeof STUB_TOOL_IDS)[number];

function makeStub(id: StubToolId): Tool {
  return tool({
    description: `[stub] ${id} — logs and returns success without performing any real side effect. Replaced per-skill when production wiring lands.`,
    inputSchema: zodSchema(z.record(z.string(), z.unknown()).optional()),
    execute: async (input) => {
      console.log(`[stub-tool] ${id} called with`, input ?? {});
      return { ok: true, stub: id };
    },
  });
}

const STUBS: Record<StubToolId, Tool> = Object.fromEntries(
  STUB_TOOL_IDS.map((id) => [id, makeStub(id)]),
) as Record<StubToolId, Tool>;

export function isStubTool(id: string): id is StubToolId {
  return (STUB_TOOL_IDS as readonly string[]).includes(id);
}

export function getStubTool(id: StubToolId): Tool {
  return STUBS[id];
}
