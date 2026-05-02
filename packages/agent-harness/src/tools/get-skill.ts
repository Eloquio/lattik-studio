/**
 * `getSkill` tool factory — runtime-neutral.
 *
 * Wraps the package's `getSkill(id, caller)` lookup as an LLM-callable tool,
 * preserving the owners gate. Each agent gets its own instance of the tool
 * (the factory captures the caller id), so an unauthorized skill load
 * surfaces as a structured `error` field rather than as silent access.
 *
 * The pre-computed available-skills list goes into the tool description so
 * the LLM doesn't have to call list_skills first to discover what to load.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import { type AgentId } from "../agents.js";
import { getSkill, listSkills } from "../loader.js";

export interface CreateGetSkillToolOptions {
  /** Agent calling the tool — gates access via skill `owners` membership. */
  caller: AgentId;
  /** Override skills directory. Tests only — production uses the package default. */
  skillsDir?: string;
}

export function createGetSkillTool(opts: CreateGetSkillToolOptions) {
  const available = listSkills(opts.caller, { skillsDir: opts.skillsDir })
    .map((s) => `${s.frontmatter.name}: ${s.frontmatter.description}`)
    .join("\n");

  const description = available
    ? `Load a skill body to guide your work. Available skills:\n${available}`
    : `Load a skill body to guide your work. (No skills currently available for ${opts.caller}.)`;

  return tool({
    description,
    inputSchema: zodSchema(
      z.object({
        skillId: z.string().describe("The skill name to load (frontmatter.name)."),
      }),
    ),
    execute: async (input: { skillId: string }) => {
      try {
        const skill = getSkill(input.skillId, opts.caller, {
          skillsDir: opts.skillsDir,
        });
        return {
          skillId: skill.frontmatter.name,
          version: skill.frontmatter.version,
          body: skill.body,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
