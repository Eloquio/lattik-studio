/**
 * SKILL.md loader.
 *
 * Discovers all skills under `<package>/skills/<name>/SKILL.md`, parses
 * frontmatter (gray-matter + zod), and exposes lookup APIs that filter by
 * the calling agent's `owners:` membership. Loading is cached on first call;
 * tests can reset the cache via `resetSkillCacheForTests`.
 *
 * The default skill directory resolves relative to this file's location, so
 * the same package works whether consumed from the web app, the worker, or
 * a test harness.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { runtimeOf, type AgentId } from "./agents.js";
import { isToolRegistered } from "./tools.js";
import { skillFrontmatterSchema, type Skill } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default skills directory: `<package>/skills/`. Resolves the same in src/ and dist/. */
const DEFAULT_SKILLS_DIR = join(__dirname, "..", "skills");

let cache: Map<string, Skill> | null = null;
let cacheDir: string | null = null;

function loadAll(skillsDir: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const skillPath = join(entryPath, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(skillPath, "utf-8");
    } catch {
      // Directory without a SKILL.md — skip silently. Catches half-migrated
      // or scratch directories sitting alongside real skills.
      continue;
    }

    const parsed = matter(raw);
    const result = skillFrontmatterSchema.safeParse(parsed.data);
    if (!result.success) {
      throw new Error(
        `Invalid SKILL.md frontmatter at ${skillPath}: ${result.error.message}`,
      );
    }

    const frontmatter = result.data;
    if (frontmatter.name !== entry) {
      throw new Error(
        `SKILL.md at ${skillPath}: frontmatter.name "${frontmatter.name}" must match directory name "${entry}"`,
      );
    }
    if (skills.has(frontmatter.name)) {
      throw new Error(
        `Duplicate skill "${frontmatter.name}" at ${skillPath}`,
      );
    }

    skills.set(frontmatter.name, {
      frontmatter,
      body: parsed.content.trim(),
      path: skillPath,
    });
  }
  return skills;
}

function ensureLoaded(skillsDir: string = DEFAULT_SKILLS_DIR): Map<string, Skill> {
  if (cache && cacheDir === skillsDir) return cache;
  cache = loadAll(skillsDir);
  cacheDir = skillsDir;
  return cache;
}

/** Reset the in-memory skill cache. Tests only — production should rely on the cache. */
export function resetSkillCacheForTests(): void {
  cache = null;
  cacheDir = null;
}

/**
 * List skills the given agent is allowed to load (owners.includes(caller)).
 * Sorted by name for stable output.
 */
export function listSkills(
  caller: AgentId,
  opts?: { skillsDir?: string },
): Skill[] {
  const all = ensureLoaded(opts?.skillsDir);
  const out: Skill[] = [];
  for (const skill of all.values()) {
    if (skill.frontmatter.owners.includes(caller)) out.push(skill);
  }
  out.sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  return out;
}

/**
 * Look up a skill by id, enforcing owners. Throws when the caller isn't an
 * owner — the same surface `loadSkill(id)` will check at runtime, mirrored
 * here so callers get the same error semantics regardless of entry point.
 */
export function getSkill(
  id: string,
  caller: AgentId,
  opts?: { skillsDir?: string },
): Skill {
  const all = ensureLoaded(opts?.skillsDir);
  const skill = all.get(id);
  if (!skill) {
    throw new Error(`Skill "${id}" not found`);
  }
  if (!skill.frontmatter.owners.includes(caller)) {
    throw new Error(
      `Agent "${caller}" is not an owner of skill "${id}" (owners: ${skill.frontmatter.owners.join(", ")})`,
    );
  }
  return skill;
}

export interface PreflightIssue {
  skill: string;
  owner: AgentId;
  toolId: string;
  reason: "missing-from-runtime";
}

/**
 * Validate that every skill's declared tools resolve in each owner's runtime
 * registry. Returns an array of issues (empty = clean). Callers decide how
 * loud to be — log warnings in dev, throw in CI.
 */
export function preflightSkills(opts?: {
  skillsDir?: string;
}): PreflightIssue[] {
  const all = ensureLoaded(opts?.skillsDir);
  const issues: PreflightIssue[] = [];
  for (const skill of all.values()) {
    for (const owner of skill.frontmatter.owners) {
      const runtime = runtimeOf(owner);
      for (const toolId of skill.frontmatter.tools) {
        if (!isToolRegistered(runtime, toolId)) {
          issues.push({
            skill: skill.frontmatter.name,
            owner,
            toolId,
            reason: "missing-from-runtime",
          });
        }
      }
    }
  }
  return issues;
}
