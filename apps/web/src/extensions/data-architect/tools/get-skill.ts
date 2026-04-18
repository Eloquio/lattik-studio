import { zodSchema } from "ai";
import { z } from "zod";
import { skills, getSkillContent } from "../skills";

export const getSkillTool = {
  description:
    "Load a skill document to guide the workflow. Call this before starting any definition task. Available skills: " +
    skills
      .filter((s) => s.audience === "agent")
      .map((s) => s.id)
      .join(", "),
  inputSchema: zodSchema(
    z.object({
      skillId: z.string().describe("The skill ID to load"),
    })
  ),
  execute: async (input: { skillId: string }) => {
    const content = getSkillContent(input.skillId);
    if (!content) {
      return { error: `Skill '${input.skillId}' not found` };
    }
    return { skill: content };
  },
};
