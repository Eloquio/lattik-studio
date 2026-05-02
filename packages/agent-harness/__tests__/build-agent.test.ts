import { describe, it, expect } from "vitest";
import {
  renderInstructions,
  assertBaseToolsResolve,
} from "../src/build-agent.js";
import type { Agent } from "../src/agent-schema.js";

function makeAgent(
  overrides: Partial<Agent["frontmatter"]> = {},
  body = "Body",
): Agent {
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

describe("assertBaseToolsResolve", () => {
  it("returns silently when every base_tool is in the name set", () => {
    const agent = makeAgent({ base_tools: ["alpha", "beta"] });
    expect(() =>
      assertBaseToolsResolve(agent, ["alpha", "beta", "extra"]),
    ).not.toThrow();
  });

  it("accepts a ReadonlySet as well as an array", () => {
    const agent = makeAgent({ base_tools: ["alpha"] });
    expect(() =>
      assertBaseToolsResolve(agent, new Set(["alpha", "beta"])),
    ).not.toThrow();
  });

  it("throws listing every unknown name and what was available", () => {
    const agent = makeAgent({ base_tools: ["alpha", "beta", "gamma"] });
    expect(() =>
      assertBaseToolsResolve(agent, ["alpha"]),
    ).toThrow(/unknown tools: beta, gamma\. Available: alpha/);
  });

  it("includes the agent id in the error message", () => {
    const agent = makeAgent({ id: "DataAnalyst", base_tools: ["missing"] });
    expect(() => assertBaseToolsResolve(agent, [])).toThrow(/Agent "DataAnalyst"/);
  });
});
