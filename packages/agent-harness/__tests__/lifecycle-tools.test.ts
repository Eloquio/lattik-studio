import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGetSkillTool,
  createListSkillsTool,
} from "../src/index.js";
import { resetSkillCacheForTests } from "../src/loader.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "harness-tools-test-"));
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

const skillFrontmatter = (name: string, owners: string) => `name: ${name}
description: Test skill ${name}
version: "0.1"
owners: [${owners}]`;

describe("createGetSkillTool", () => {
  it("returns the skill body for an authorized caller", async () => {
    writeSkill("alpha", skillFrontmatter("alpha", "ExecutorAgent"), "Alpha body.");
    const t = createGetSkillTool({ caller: "ExecutorAgent", skillsDir: tmp });
    const result = await t.execute!(
      { skillId: "alpha" },
      { messages: [], toolCallId: "t1" },
    );
    expect(result).toMatchObject({
      skillId: "alpha",
      version: "0.1",
      body: "Alpha body.",
    });
  });

  it("returns a structured error when the skill is missing", async () => {
    const t = createGetSkillTool({ caller: "ExecutorAgent", skillsDir: tmp });
    const result = await t.execute!(
      { skillId: "missing" },
      { messages: [], toolCallId: "t1" },
    );
    expect(result).toEqual({ error: expect.stringMatching(/not found/) });
  });

  it("returns a structured error when the caller is not an owner", async () => {
    writeSkill("alpha", skillFrontmatter("alpha", "ExecutorAgent"));
    const t = createGetSkillTool({ caller: "DataArchitect", skillsDir: tmp });
    const result = await t.execute!(
      { skillId: "alpha" },
      { messages: [], toolCallId: "t1" },
    );
    expect(result).toEqual({ error: expect.stringMatching(/not an owner/) });
  });

  it("includes the caller's available skills in the description", () => {
    writeSkill("alpha", skillFrontmatter("alpha", "ExecutorAgent"));
    writeSkill("beta", skillFrontmatter("beta", "DataArchitect"));
    const t = createGetSkillTool({ caller: "ExecutorAgent", skillsDir: tmp });
    expect(t.description).toContain("alpha:");
    expect(t.description).not.toContain("beta:");
  });

  it("notes when no skills are available for the caller", () => {
    const t = createGetSkillTool({ caller: "Assistant", skillsDir: tmp });
    expect(t.description).toContain("No skills currently available");
  });
});

describe("createListSkillsTool", () => {
  it("returns frontmatter for skills the caller owns", async () => {
    writeSkill("alpha", skillFrontmatter("alpha", "ExecutorAgent"));
    writeSkill("beta", skillFrontmatter("beta", "DataArchitect"));
    writeSkill("shared", `name: shared
description: Test skill shared
version: "0.1"
owners: [ExecutorAgent, DataArchitect]`);

    const t = createListSkillsTool({ caller: "ExecutorAgent", skillsDir: tmp });
    const result = (await t.execute!(
      {},
      { messages: [], toolCallId: "t1" },
    )) as { skills: Array<{ name: string }> };
    expect(result.skills.map((s) => s.name).sort()).toEqual(["alpha", "shared"]);
  });

  it("returns no body in the listing — bodies are loaded lazily via getSkill", async () => {
    writeSkill(
      "alpha",
      skillFrontmatter("alpha", "ExecutorAgent"),
      "This body should not appear.",
    );
    const t = createListSkillsTool({ caller: "ExecutorAgent", skillsDir: tmp });
    const result = await t.execute!({}, { messages: [], toolCallId: "t1" });
    expect(JSON.stringify(result)).not.toContain("This body should not appear");
  });
});
