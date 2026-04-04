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
    id: "defining-entity",
    title: "Defining a New Entity",
    description:
      "How to define a business entity (e.g. user, game) with an ID field",
    filename: "defining-entity.md",
  },
  {
    id: "defining-dimension",
    title: "Defining a New Canonical Dimension",
    description:
      "How to define a dimension attribute of an entity (e.g. user_home_country)",
    filename: "defining-dimension.md",
  },
  {
    id: "defining-logger-table",
    title: "Defining a New Logger Table",
    description:
      "How to define a raw append-only event table with columns and retention",
    filename: "defining-logger-table.md",
  },
  {
    id: "defining-lattik-table",
    title: "Defining a New Lattik Table",
    description:
      "How to define a derived/aggregated super wide table with column families",
    filename: "defining-lattik-table.md",
  },
  {
    id: "defining-metric",
    title: "Defining a New Canonical Metric",
    description:
      "How to define a metric as a collection of aggregation expressions",
    filename: "defining-metric.md",
  },
];

const skillsDir = join(
  dirname(fileURLToPath(import.meta.url))
);

export function getSkillContent(skillId: string): string | null {
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return null;
  return readFileSync(join(skillsDir, skill.filename), "utf-8");
}
