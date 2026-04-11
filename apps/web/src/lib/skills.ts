/**
 * Skill loader and instantiation.
 *
 * Skills are reusable task templates stored as YAML files in `src/skills/`.
 * The planner agent loads skills at planning time, matches incoming requests,
 * and instantiates tasks from templates — optionally auto-approving if the
 * skill allows it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface SkillArg {
  type: string;
  description: string;
  default?: unknown;
}

export interface SkillTaskTemplate {
  agent: string;
  description: string;
  done_criteria: string;
}

export interface Skill {
  name: string;
  description: string;
  auto_approve: boolean;
  args: Record<string, SkillArg>;
  tasks: SkillTaskTemplate[];
}

interface InstantiatedTask {
  agentId: string;
  description: string;
  doneCriteria: string;
}

const SKILLS_DIR = join(process.cwd(), "src/skills");

/**
 * Load all skill YAML files from the skills directory.
 */
export function loadSkills(): Skill[] {
  let files: string[];
  try {
    files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return [];
  }

  return files.map((file) => {
    const content = readFileSync(join(SKILLS_DIR, file), "utf-8");
    return yaml.load(content) as Skill;
  });
}

/**
 * Find a skill by name.
 */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name);
}

/**
 * Interpolate `{{arg}}` placeholders in a string with provided values.
 */
function interpolate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = args[key];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

/**
 * Instantiate a skill's task templates with the given arguments.
 * Returns task definitions ready to insert into the database.
 */
export function instantiateSkill(
  skill: Skill,
  args: Record<string, unknown>
): InstantiatedTask[] {
  // Apply defaults for missing args
  const resolvedArgs: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(skill.args)) {
    resolvedArgs[key] = args[key] ?? def.default;
  }

  return skill.tasks.map((template) => ({
    agentId: template.agent,
    description: interpolate(template.description, resolvedArgs),
    doneCriteria: interpolate(template.done_criteria, resolvedArgs),
  }));
}
