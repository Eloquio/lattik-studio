/**
 * SKILL.md frontmatter schema.
 *
 * Every skill is a runbook — a single capability an agent loads and follows.
 * Decomposition into multiple tasks is the application's job (the Planner
 * Agent or webhook code), not the skill's. This matches Anthropic's skill
 * model: skills are loaded on demand by their `description`, the body is the
 * LLM-facing instructions, and tools are granted for the duration of the
 * load.
 */

import { z } from "zod";
import { ALL_AGENT_IDS, type AgentId } from "./agents.js";

const agentIdSchema = z.enum(ALL_AGENT_IDS as [AgentId, ...AgentId[]]);

const skillArgSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().optional().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

const doneCheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sql"),
    query: z.string(),
    expect: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.string(),
    method: z.string().optional().default("GET"),
    expect_status: z.number().optional(),
  }),
  z.object({
    kind: z.literal("s3_object_exists"),
    bucket: z.string(),
    key: z.string(),
  }),
  z.object({
    kind: z.literal("shell"),
    command: z.string(),
    expect_exit: z.number().optional().default(0),
  }),
]);

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  owners: z.array(agentIdSchema).min(1),
  tools: z.array(z.string()).optional().default([]),
  args: z.record(z.string(), skillArgSchema).optional().default({}),
  done: z.array(doneCheckSchema).optional().default([]),
  auto_approve: z.boolean().optional().default(false),
  when: z
    .object({
      triggers: z.array(z.string()).optional().default([]),
      keywords: z.array(z.string()).optional().default([]),
    })
    .optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
export type SkillArg = z.infer<typeof skillArgSchema>;
export type DoneCheck = z.infer<typeof doneCheckSchema>;

/**
 * A loaded skill: validated frontmatter + body + on-disk path.
 */
export interface Skill {
  frontmatter: SkillFrontmatter;
  /** Markdown body — the LLM-facing instructions for the loading agent. */
  body: string;
  /** Absolute path to the SKILL.md file. Useful for error messages. */
  path: string;
}
