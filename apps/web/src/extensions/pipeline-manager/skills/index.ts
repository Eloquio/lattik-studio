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
    id: "monitoring-dags",
    title: "Monitoring DAG Health",
    description:
      "How to check DAG status, drill into failures, view task logs, and retry",
    filename: "monitoring-dags.md",
  },
  {
    id: "triggering-runs",
    title: "Triggering Runs & Backfills",
    description:
      "How to manually trigger a DAG run or kick off a backfill with a date range",
    filename: "triggering-runs.md",
  },
  {
    id: "troubleshooting-failures",
    title: "Troubleshooting Failures",
    description:
      "Guided troubleshooting for common failure patterns: sensor timeout, Spark OOM, driver crash, S3 access errors",
    filename: "troubleshooting-failures.md",
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
