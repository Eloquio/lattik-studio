import { createGetSkillTool } from "../../tools/get-skill";
import { skills, getSkillContent } from "../skills";

export const getSkillTool = createGetSkillTool({
  descriptionPrefix:
    "Load a skill document to guide the workflow. Call this before starting any definition task.",
  skills,
  getSkillContent,
  // Reviewer-audience skills (e.g. policy docs for the review LLM) stay
  // loadable by id but don't show up in the agent's skill menu.
  filter: (s) => s.audience === "agent",
});
