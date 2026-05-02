/**
 * AGENT.md loader.
 *
 * Discovers all agents under `<root>/<dir>/AGENT.md`, parses frontmatter
 * (gray-matter + zod), and exposes lookup APIs keyed by the canonical
 * AgentId from the frontmatter. Loading is cached on first call; tests can
 * reset the cache via `resetAgentCacheForTests`.
 *
 * Unlike SKILL.md, agents do NOT live inside this package — they live in
 * each consuming app (`apps/agent-service/src/agents/...`,
 * `apps/agent-worker/src/agents/...`). The caller passes `agentsDir`
 * explicitly; there is no useful in-package default.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { type AgentId } from "./agents.js";
import { agentFrontmatterSchema, type Agent } from "./agent-schema.js";

const cache = new Map<string, Map<AgentId, Agent>>();

function loadAll(agentsDir: string): Map<AgentId, Agent> {
  const agents = new Map<AgentId, Agent>();
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    const entryPath = join(agentsDir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const agentPath = join(entryPath, "AGENT.md");
    let raw: string;
    try {
      raw = readFileSync(agentPath, "utf-8");
    } catch {
      // Directory without an AGENT.md — skip silently. Lets unrelated
      // sub-dirs (e.g. `tools/`, `skills/`) sit alongside agent folders.
      continue;
    }

    const parsed = matter(raw);
    const result = agentFrontmatterSchema.safeParse(parsed.data);
    if (!result.success) {
      throw new Error(
        `Invalid AGENT.md frontmatter at ${agentPath}: ${result.error.message}`,
      );
    }

    const frontmatter = result.data;
    if (agents.has(frontmatter.id)) {
      const prior = agents.get(frontmatter.id)!;
      throw new Error(
        `Duplicate agent id "${frontmatter.id}" — defined at both ${prior.path} and ${agentPath}`,
      );
    }

    agents.set(frontmatter.id, {
      frontmatter,
      body: parsed.content.trim(),
      path: agentPath,
    });
  }
  return agents;
}

function ensureLoaded(agentsDir: string): Map<AgentId, Agent> {
  let cached = cache.get(agentsDir);
  if (cached) return cached;
  cached = loadAll(agentsDir);
  cache.set(agentsDir, cached);
  return cached;
}

/** Reset the in-memory agent cache. Tests only — production should rely on the cache. */
export function resetAgentCacheForTests(): void {
  cache.clear();
}

/**
 * List every loaded agent, sorted by id for stable output.
 */
export function listAgents(opts: { agentsDir: string }): Agent[] {
  const all = ensureLoaded(opts.agentsDir);
  return Array.from(all.values()).sort((a, b) =>
    a.frontmatter.id.localeCompare(b.frontmatter.id),
  );
}

/**
 * Look up an agent by id. Throws if no AGENT.md declares this id under
 * `agentsDir` — that's a startup misconfiguration the caller should surface.
 */
export function getAgent(
  id: AgentId,
  opts: { agentsDir: string },
): Agent {
  const all = ensureLoaded(opts.agentsDir);
  const agent = all.get(id);
  if (!agent) {
    throw new Error(`Agent "${id}" not found under ${opts.agentsDir}`);
  }
  return agent;
}

/**
 * Parse a list of pre-loaded AGENT.md entries into the agent map. Used by
 * runtimes that don't have filesystem access at runtime (e.g. a Nitro
 * production bundle), where AGENT.md content is pulled in at build time
 * and embedded in a generated manifest module.
 *
 * Same validation rules as the directory-walking loader: zod-checked
 * frontmatter, no duplicate ids, body trimmed.
 */
export function parseAgents(
  entries: ReadonlyArray<{ path: string; content: string }>,
): Map<AgentId, Agent> {
  const agents = new Map<AgentId, Agent>();
  for (const entry of entries) {
    const parsed = matter(entry.content);
    const result = agentFrontmatterSchema.safeParse(parsed.data);
    if (!result.success) {
      throw new Error(
        `Invalid AGENT.md frontmatter at ${entry.path}: ${result.error.message}`,
      );
    }
    const frontmatter = result.data;
    if (agents.has(frontmatter.id)) {
      const prior = agents.get(frontmatter.id)!;
      throw new Error(
        `Duplicate agent id "${frontmatter.id}" — defined at both ${prior.path} and ${entry.path}`,
      );
    }
    agents.set(frontmatter.id, {
      frontmatter,
      body: parsed.content.trim(),
      path: entry.path,
    });
  }
  return agents;
}
