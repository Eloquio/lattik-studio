import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listSkills,
  getSkill,
  preflightSkills,
  resetSkillCacheForTests,
} from "../src/loader.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "skills-test-"));
  resetSkillCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetSkillCacheForTests();
});

function writeSkill(name: string, frontmatter: string, body = "Body."): void {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("listSkills", () => {
  it("returns only skills owned by the caller", () => {
    writeSkill(
      "exec-only",
      `name: exec-only
description: Worker-only skill
version: "0.1"
owners: [ExecutorAgent]`,
    );
    writeSkill(
      "chat-only",
      `name: chat-only
description: Chat-only skill
version: "0.1"
owners: [DataArchitect]`,
    );
    writeSkill(
      "shared",
      `name: shared
description: Both runtimes
version: "0.1"
owners: [ExecutorAgent, DataArchitect]`,
    );

    const execList = listSkills("ExecutorAgent", { skillsDir: tmp });
    expect(execList.map((s) => s.frontmatter.name).sort()).toEqual([
      "exec-only",
      "shared",
    ]);

    const chatList = listSkills("DataArchitect", { skillsDir: tmp });
    expect(chatList.map((s) => s.frontmatter.name).sort()).toEqual([
      "chat-only",
      "shared",
    ]);

    const noneList = listSkills("Assistant", { skillsDir: tmp });
    expect(noneList).toEqual([]);
  });
});

describe("getSkill", () => {
  it("returns the skill for an authorized caller", () => {
    writeSkill(
      "alpha",
      `name: alpha
description: Test
version: "0.1"
owners: [ExecutorAgent]`,
    );
    const skill = getSkill("alpha", "ExecutorAgent", { skillsDir: tmp });
    expect(skill.frontmatter.name).toBe("alpha");
  });

  it("throws when the skill is not found", () => {
    expect(() =>
      getSkill("missing", "ExecutorAgent", { skillsDir: tmp }),
    ).toThrow(/not found/);
  });

  it("throws when the caller is not an owner", () => {
    writeSkill(
      "alpha",
      `name: alpha
description: Test
version: "0.1"
owners: [ExecutorAgent]`,
    );
    expect(() =>
      getSkill("alpha", "DataArchitect", { skillsDir: tmp }),
    ).toThrow(/not an owner/);
  });
});

describe("frontmatter validation", () => {
  it("rejects malformed frontmatter (missing required field)", () => {
    writeSkill(
      "bad",
      `name: bad
description: Missing owners
version: "0.1"`,
    );
    expect(() => listSkills("ExecutorAgent", { skillsDir: tmp })).toThrow(
      /Invalid SKILL.md frontmatter/,
    );
  });

  it("rejects unknown agent ids in owners", () => {
    writeSkill(
      "bad",
      `name: bad
description: Bogus owner
version: "0.1"
owners: [NotAnAgent]`,
    );
    expect(() => listSkills("ExecutorAgent", { skillsDir: tmp })).toThrow(
      /Invalid SKILL.md frontmatter/,
    );
  });

  it("rejects when frontmatter.name doesn't match the directory name", () => {
    writeSkill(
      "directory-name",
      `name: different-name
description: Mismatched
version: "0.1"
owners: [ExecutorAgent]`,
    );
    expect(() => listSkills("ExecutorAgent", { skillsDir: tmp })).toThrow(
      /must match directory name/,
    );
  });
});

describe("preflightSkills", () => {
  it("returns no issues when all tools resolve in each owner's runtime", () => {
    writeSkill(
      "ok",
      `name: ok
description: All tools resolved
version: "0.1"
owners: [ExecutorAgent]
tools: [s3:write, kafka:write]`,
    );
    const issues = preflightSkills({ skillsDir: tmp });
    expect(issues).toEqual([]);
  });

  it("reports tools that aren't registered in an owner's runtime", () => {
    // renderCanvas is chat-only; loading it via ExecutorAgent (worker) should warn.
    writeSkill(
      "mismatch",
      `name: mismatch
description: Tool not in worker registry
version: "0.1"
owners: [ExecutorAgent]
tools: [renderCanvas]`,
    );
    const issues = preflightSkills({ skillsDir: tmp });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      skill: "mismatch",
      owner: "ExecutorAgent",
      toolId: "renderCanvas",
      reason: "missing-from-runtime",
    });
  });

  it("reports issues per (skill, owner) pair when a tool is missing in some runtimes", () => {
    // s3:write is worker-only. With both owners, the chat owner gets flagged.
    writeSkill(
      "cross",
      `name: cross
description: Cross-runtime skill
version: "0.1"
owners: [ExecutorAgent, DataArchitect]
tools: [s3:write]`,
    );
    const issues = preflightSkills({ skillsDir: tmp });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.owner).toBe("DataArchitect");
    expect(issues[0]?.toolId).toBe("s3:write");
  });
});
