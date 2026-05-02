import { describe, it, expect } from "vitest";
import { tool, zodSchema, type Tool } from "ai";
import { z } from "zod";
import {
  renderInstructions,
  resolveBaseTools,
  buildAgent,
} from "../src/build-agent.js";
import type { Agent } from "../src/agent-schema.js";

function makeAgent(overrides: Partial<Agent["frontmatter"]> = {}, body = "Body"): Agent {
  return {
    frontmatter: {
      id: "PipelineManager",
      name: "Pipeline Manager",
      description: "Test agent",
      model: "anthropic/claude-sonnet-4.6",
      max_steps: 10,
      base_tools: ["alpha"],
      ...overrides,
    },
    body,
    path: "/tmp/AGENT.md",
  };
}

function makeTool(name: string): Tool {
  return tool({
    description: `${name} tool`,
    inputSchema: zodSchema(z.object({})),
    execute: async () => ({ ok: true }),
  });
}

describe("renderInstructions", () => {
  it("substitutes {{skills}} when provided", () => {
    expect(
      renderInstructions("Skills: {{skills}}", { skills: "- foo\n- bar" }),
    ).toBe("Skills: - foo\n- bar");
  });

  it("strips {{skills}} when not provided", () => {
    expect(renderInstructions("Skills: {{skills}}", {})).toBe("Skills: ");
  });

  it("wraps {{resumeContext}} with [CONTEXT] prefix when non-empty", () => {
    expect(
      renderInstructions("{{resumeContext}}Body", { resumeContext: "prior turn" }),
    ).toBe("[CONTEXT] prior turn\n\nBody");
  });

  it("strips {{resumeContext}} when empty or missing", () => {
    expect(renderInstructions("{{resumeContext}}Body", { resumeContext: "" })).toBe(
      "Body",
    );
    expect(renderInstructions("{{resumeContext}}Body", {})).toBe("Body");
  });

  it("leaves unknown {{...}} seams literal", () => {
    expect(
      renderInstructions("Hello {{user}}, list {{skills}}", { skills: "(none)" }),
    ).toBe("Hello {{user}}, list (none)");
  });
});

describe("resolveBaseTools", () => {
  it("returns the subset named in base_tools", () => {
    const agent = makeAgent({ base_tools: ["alpha", "beta"] });
    const registry = { alpha: makeTool("alpha"), beta: makeTool("beta"), extra: makeTool("extra") };
    const resolved = resolveBaseTools(agent, registry);
    expect(Object.keys(resolved).sort()).toEqual(["alpha", "beta"]);
  });

  it("throws listing every unknown name and what was available", () => {
    const agent = makeAgent({ base_tools: ["alpha", "beta", "gamma"] });
    const registry = { alpha: makeTool("alpha") };
    expect(() => resolveBaseTools(agent, registry)).toThrow(
      /unknown tools: beta, gamma\. Available: alpha/,
    );
  });
});

describe("buildAgent", () => {
  it("produces a ToolLoopAgent with the agent's id, model, and step cap", () => {
    const agent = makeAgent({ max_steps: 7 });
    const built = buildAgent({
      agent,
      tools: { alpha: makeTool("alpha") },
    });
    // Smoke-test the wrapper — id and the shape of the return value. We
    // can't easily exercise generate() without a real provider, but
    // construction failures (unknown tool, bad model id format) would
    // throw here.
    expect(built).toBeDefined();
    expect((built as unknown as { id: string }).id).toBe("PipelineManager");
  });

  it("propagates resolveBaseTools errors", () => {
    const agent = makeAgent({ base_tools: ["missing"] });
    expect(() => buildAgent({ agent, tools: {} })).toThrow(/unknown tools: missing/);
  });
});
