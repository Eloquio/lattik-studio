import { zodSchema } from "ai";
import { z } from "zod";
import type { BaseSkillMeta } from "../types";

/**
 * Framework helper for the per-extension `getSkill` tool. Each extension
 * supplies its own skill catalogue, content loader, and optional filter (so
 * data-architect can hide reviewer-audience docs from the agent menu). The
 * tool shape and input schema are framework-owned.
 */
export function createGetSkillTool<S extends BaseSkillMeta>({
  descriptionPrefix,
  skills,
  getSkillContent,
  filter,
}: {
  /**
   * Sentence that explains the tool to the model. The list of available
   * skill IDs is appended automatically.
   */
  descriptionPrefix: string;
  skills: S[];
  getSkillContent: (skillId: string) => string | null;
  /**
   * Hide skills from the agent's menu (but keep them loadable by ID).
   * data-architect uses this to keep reviewer-audience docs out of the
   * agent's view without removing them from the catalogue.
   */
  filter?: (skill: S) => boolean;
}) {
  const visible = filter ? skills.filter(filter) : skills;
  const ids = visible.map((s) => s.id).join(", ");

  return {
    description: `${descriptionPrefix} Available skills: ${ids}`,
    inputSchema: zodSchema(
      z.object({
        skillId: z.string().describe("The skill ID to load"),
      }),
    ),
    execute: async (input: { skillId: string }) => {
      const content = getSkillContent(input.skillId);
      if (!content) {
        return { error: `Skill '${input.skillId}' not found` };
      }
      return { skill: content };
    },
  };
}
