import { createGetSkillTool } from "../../tools/get-skill";
import { skills, getSkillContent } from "../skills";

export const getSkillTool = createGetSkillTool({
  descriptionPrefix:
    "Load a skill document to guide the workflow. Call this before starting any pipeline management task.",
  skills,
  getSkillContent,
});
