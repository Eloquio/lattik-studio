/**
 * `list_skills` — return the catalogue of skills the Executor can run.
 *
 * Returns frontmatter only (no body) — the Planner picks skills based on
 * description + args; the body is the runbook the Executor follows during
 * execution. Saves tokens.
 */

import { z } from "zod";
import { tool, zodSchema } from "ai";
import { listSkills } from "@eloquio/agent-harness";

export const listSkillsTool = tool({
  description:
    "List skills the Executor Agent can run. Use this to discover what work is available before emitting tasks.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => {
    const skills = listSkills("ExecutorAgent");
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
