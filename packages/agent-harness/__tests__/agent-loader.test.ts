import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listAgents,
  getAgent,
  parseAgents,
  resetAgentCacheForTests,
} from "../src/agent-loader.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agents-test-"));
  resetAgentCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetAgentCacheForTests();
});

function writeAgent(
  dir: string,
  frontmatter: string,
  body = "You are an agent.",
): void {
  const path = join(tmp, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "AGENT.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

const validFrontmatter = (id: string) => `id: ${id}
name: Test Agent
description: An agent used in tests.
model: anthropic/claude-sonnet-4.6
max_steps: 10
base_tools:
  - getSkill
  - handback`;

describe("listAgents", () => {
  it("returns every loaded agent sorted by id", () => {
    writeAgent("pipeline-manager", validFrontmatter("PipelineManager"));
    writeAgent("data-architect", validFrontmatter("DataArchitect"));
    writeAgent("data-analyst", validFrontmatter("DataAnalyst"));

    const agents = listAgents({ agentsDir: tmp });
    expect(agents.map((a) => a.frontmatter.id)).toEqual([
      "DataAnalyst",
      "DataArchitect",
      "PipelineManager",
    ]);
  });

  it("returns an empty array when the directory has no AGENT.md files", () => {
    expect(listAgents({ agentsDir: tmp })).toEqual([]);
  });

  it("ignores subdirectories that lack an AGENT.md", () => {
    writeAgent("pipeline-manager", validFrontmatter("PipelineManager"));
    // A `tools` directory next to the agent folder — must be skipped silently.
    mkdirSync(join(tmp, "tools"), { recursive: true });
    writeFileSync(join(tmp, "tools", "list-dags.ts"), "export const x = 1;\n");

    const agents = listAgents({ agentsDir: tmp });
    expect(agents).toHaveLength(1);
    expect(agents[0]?.frontmatter.id).toBe("PipelineManager");
  });
});

describe("getAgent", () => {
  it("returns the agent for a known id", () => {
    writeAgent(
      "pipeline-manager",
      validFrontmatter("PipelineManager"),
      "Pipeline Manager body.",
    );
    const agent = getAgent("PipelineManager", { agentsDir: tmp });
    expect(agent.frontmatter.id).toBe("PipelineManager");
    expect(agent.body).toBe("Pipeline Manager body.");
  });

  it("throws when the id is unknown", () => {
    expect(() => getAgent("PipelineManager", { agentsDir: tmp })).toThrow(
      /Agent "PipelineManager" not found/,
    );
  });
});

describe("frontmatter validation", () => {
  it("rejects an unknown agent id", () => {
    writeAgent(
      "bogus",
      `id: NotARealAgent
name: Bogus
description: Bogus
model: anthropic/claude-sonnet-4.6
max_steps: 10
base_tools: [getSkill]`,
    );
    expect(() => listAgents({ agentsDir: tmp })).toThrow(
      /Invalid AGENT.md frontmatter/,
    );
  });

  it("rejects missing required fields", () => {
    writeAgent(
      "pipeline-manager",
      `id: PipelineManager
name: Pipeline Manager
description: Missing model and max_steps
base_tools: [getSkill]`,
    );
    expect(() => listAgents({ agentsDir: tmp })).toThrow(
      /Invalid AGENT.md frontmatter/,
    );
  });

  it("rejects an empty base_tools list", () => {
    writeAgent(
      "pipeline-manager",
      `id: PipelineManager
name: Pipeline Manager
description: Empty base_tools
model: anthropic/claude-sonnet-4.6
max_steps: 10
base_tools: []`,
    );
    expect(() => listAgents({ agentsDir: tmp })).toThrow(
      /Invalid AGENT.md frontmatter/,
    );
  });

  it("rejects a non-positive max_steps", () => {
    writeAgent(
      "pipeline-manager",
      `id: PipelineManager
name: Pipeline Manager
description: Bad max_steps
model: anthropic/claude-sonnet-4.6
max_steps: 0
base_tools: [getSkill]`,
    );
    expect(() => listAgents({ agentsDir: tmp })).toThrow(
      /Invalid AGENT.md frontmatter/,
    );
  });
});

describe("duplicate ids", () => {
  it("throws when two AGENT.md files declare the same id", () => {
    writeAgent("pipeline-manager", validFrontmatter("PipelineManager"));
    writeAgent("pipeline-manager-dup", validFrontmatter("PipelineManager"));
    expect(() => listAgents({ agentsDir: tmp })).toThrow(
      /Duplicate agent id "PipelineManager"/,
    );
  });
});

describe("parseAgents", () => {
  function entry(id: string, body = "Body"): { path: string; content: string } {
    return {
      path: `${id}/AGENT.md`,
      content: `---\n${validFrontmatter(id)}\n---\n\n${body}\n`,
    };
  }

  it("parses a list of pre-loaded entries into the agent map", () => {
    const map = parseAgents([
      entry("PipelineManager", "Pipeline body."),
      entry("DataArchitect", "Architect body."),
    ]);
    expect([...map.keys()].sort()).toEqual(["DataArchitect", "PipelineManager"]);
    expect(map.get("PipelineManager")?.body).toBe("Pipeline body.");
    expect(map.get("DataArchitect")?.frontmatter.id).toBe("DataArchitect");
  });

  it("returns an empty map for an empty entry list", () => {
    expect(parseAgents([]).size).toBe(0);
  });

  it("rejects invalid frontmatter with the entry path in the error", () => {
    expect(() =>
      parseAgents([
        {
          path: "Bogus/AGENT.md",
          content: `---\nid: NotAnAgent\nname: x\ndescription: x\nmodel: x\nmax_steps: 1\nbase_tools: [getSkill]\n---\n\nBody`,
        },
      ]),
    ).toThrow(/Invalid AGENT.md frontmatter at Bogus\/AGENT.md/);
  });

  it("throws on duplicate ids and names both source paths", () => {
    expect(() =>
      parseAgents([entry("PipelineManager"), entry("PipelineManager")]),
    ).toThrow(/Duplicate agent id "PipelineManager"/);
  });
});
