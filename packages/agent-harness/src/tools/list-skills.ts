/**
 * `list_skills` tool factory — runtime-neutral.
 *
 * Returns frontmatter only (no body) so the calling agent can pick a skill
 * by description without paying body tokens. Filtered by the caller's
 * owners membership — same access control as `getSkill`.
 *
 * Used by Planner-style agents that schedule work for someone else (their
 * job is to pick the right skill from the catalogue, not run it). The
 * loaded body is later read by `getSkill` when the runtime actually
 * dispatches the run.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import { type AgentId } from "../agents.js";
import { listSkills } from "../loader.js";

export interface CreateListSkillsToolOptions {
  /** Agent calling the tool — filters skills by `owners` membership. */
  caller: AgentId;
  /** Override skills directory. Tests only — production uses the package default. */
  skillsDir?: string;
}

export function createListSkillsTool(opts: CreateListSkillsToolOptions) {
  return tool({
    description: `List skills the ${opts.caller} agent can load. Returns frontmatter only (name, description, version, args, auto_approve) — load the body via getSkill.`,
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const skills = listSkills(opts.caller, { skillsDir: opts.skillsDir });
      return {
        skills: skills.map((s) => ({
          name: s.frontmatter.name,
          description: s.frontmatter.description,
          version: s.frontmatter.version,
          auto_approve: s.frontmatter.auto_approve,
          args: s.frontmatter.args,
        })),
      };
    },
  });
}
