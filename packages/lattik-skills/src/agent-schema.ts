/**
 * AGENT.md frontmatter schema.
 *
 * Each agent is a single Markdown file with YAML frontmatter — same convention
 * as SKILL.md. The harness reads these at startup and instantiates a
 * `ToolLoopAgent` per file. Mirrors how Anthropic's skill model works: the
 * frontmatter declares identity + capabilities, the body becomes the system
 * prompt verbatim (with a small, deliberately capped set of template seams).
 */

import { z } from "zod";
import { ALL_AGENT_IDS, type AgentId } from "./agents.js";

const agentIdSchema = z.enum(ALL_AGENT_IDS as [AgentId, ...AgentId[]]);

export const agentFrontmatterSchema = z.object({
  /** Canonical AgentId — must match an entry in AGENT_RUNTIME. */
  id: agentIdSchema,
  /** Human-readable display name shown in the chat UI. */
  name: z.string().min(1),
  /** One-liner shown in the specialist picker. */
  description: z.string().min(1),
  /**
   * AI Gateway model id (e.g. `anthropic/claude-sonnet-4.6`). Defaults are
   * intentionally NOT provided here — every agent must pick a model
   * explicitly so model choice is auditable.
   */
  model: z.string().min(1),
  /** Tool-loop step cap. Today's specialists use 10. */
  max_steps: z.number().int().positive(),
  /**
   * Tool names resolved against the agent's merged tool registry at startup
   * (harness ⊕ runtime-shared ⊕ this agent's `tools/`). Unknown names cause
   * startup to fail loudly — that's the only protection against typos now
   * that AGENT.md isn't TS-checked.
   */
  base_tools: z.array(z.string().min(1)).min(1),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

/**
 * A loaded agent: validated frontmatter + raw Markdown body + on-disk path.
 *
 * The body is returned verbatim. Template-seam substitution (`{{skills}}`,
 * `{{resumeContext}}`) is a separate concern handled at agent-instantiation
 * time, not here — keeps the loader pure and the body inspectable for tests.
 */
export interface Agent {
  frontmatter: AgentFrontmatter;
  /** Raw Markdown body — system prompt for the agent, before substitution. */
  body: string;
  /** Absolute path to the AGENT.md file. Useful for error messages. */
  path: string;
}
