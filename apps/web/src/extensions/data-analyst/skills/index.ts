import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface SkillMeta {
  id: string;
  title: string;
  description: string;
  filename: string;
}

export const skills: SkillMeta[] = [
  {
    id: "exploring-data",
    title: "Exploring Data",
    description:
      "Browse available tables, write SQL queries, run them against Trino, and visualize results with charts",
    filename: "exploring-data.md",
  },
];

const skillsDir = join(dirname(fileURLToPath(import.meta.url)));

const skillCache = new Map<string, string>();

export function getSkillContent(skillId: string): string | null {
  const cached = skillCache.get(skillId);
  if (cached !== undefined) return cached;
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return null;
  const content = readFileSync(join(skillsDir, skill.filename), "utf-8");
  skillCache.set(skillId, content);
  return content;
}
