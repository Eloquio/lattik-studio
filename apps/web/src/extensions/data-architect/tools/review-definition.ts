import { generateObject, gateway, zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";
import { sanitizeCanvasFormState } from "../canvas-to-spec";
import { getSkillContent } from "../skills";
import {
  loadMergedEntities,
  loadMergedDimensions,
  loadMergedTables,
} from "../validation/referential";
import type {
  Entity,
  Dimension,
  LoggerTable,
  LattikTable,
} from "../schema";

export interface ReviewAction {
  path: string;
  value: unknown;
}

export interface ReviewSuggestion {
  id: string;
  title: string;
  description: string;
  actions: ReviewAction[];
}

// Schema for the structured output we ask Sonnet to produce. We keep this
// strict (especially `actions.min(1)`) because that's the whole reason we're
// upgrading the model — Sonnet will respect it where Haiku would not.
const reviewerOutputSchema = z.object({
  suggestions: z
    .array(
      z.object({
        id: z
          .string()
          .describe("Unique snake_case suggestion ID, e.g. 'missing_desc'"),
        title: z
          .string()
          .describe("Short imperative title (5-8 words), e.g. 'Add a description'"),
        description: z
          .string()
          .describe("One or two sentences explaining the fix and why it matters"),
        actions: z
          .array(
            z.object({
              path: z
                .string()
                .describe(
                  "JSON Pointer path against the canvas form state, e.g. '/description' or '/user_columns/0/dimension'"
                ),
              value: z
                .unknown()
                .describe(
                  "The literal final value to set at this path — never a placeholder, instruction, or template"
                ),
            })
          )
          .min(1)
          .describe(
            "REQUIRED. At least one concrete patch with a literal value, ready to apply with one click."
          ),
      })
    )
    .describe(
      "List of actionable fixes. Empty array means the definition is clean and ready to proceed."
    ),
});

const SKILL_FOR_KIND: Record<DefinitionKind, string> = {
  entity: "defining-entity",
  dimension: "defining-dimension",
  logger_table: "defining-logger-table",
  lattik_table: "defining-lattik-table",
  metric: "defining-metric",
};

/**
 * Build a compact, human-readable summary of the user's existing committed
 * definitions for the reviewer's context. We include the fields the reviewer
 * actually uses to detect cross-definition conflicts (entity id_type, dimension
 * data_type, table column types) and skip everything else to keep token cost
 * down. Returns a markdown block ready to drop into the prompt.
 */
async function buildWorkspaceContext(): Promise<string> {
  // Run the loaders in parallel — they all hit the same definitions table
  // server-side and have no dependency on each other.
  const [entities, dimensions, tables] = await Promise.all([
    loadMergedEntities(),
    loadMergedDimensions(),
    loadMergedTables(),
  ]);

  const sections: string[] = [];

  if (entities.length > 0) {
    sections.push(
      "### Entities\n" +
        entities
          .map((e: Entity) => `- \`${e.name}\` — id_field: \`${e.id_field}\`, id_type: \`${e.id_type}\``)
          .join("\n")
    );
  }

  if (dimensions.length > 0) {
    sections.push(
      "### Dimensions\n" +
        dimensions
          .map(
            (d: Dimension) =>
              `- \`${d.name}\` — entity: \`${d.entity}\`, source: \`${d.source_table}.${d.source_column}\`, data_type: \`${d.data_type}\``
          )
          .join("\n")
    );
  }

  if (tables.loggerTables.length > 0) {
    sections.push(
      "### Logger tables\n" +
        tables.loggerTables
          .map((t: LoggerTable) => {
            const cols = (t.columns ?? [])
              .map((c) => `${c.name}:${c.type}`)
              .join(", ");
            return `- \`${t.name}\` — columns: ${cols || "(none)"}`;
          })
          .join("\n")
    );
  }

  if (tables.lattikTables.length > 0) {
    sections.push(
      "### Lattik tables\n" +
        tables.lattikTables
          .map((t: LattikTable) => {
            const pks = (t.primary_key ?? [])
              .map((pk) => `${pk.column}(${pk.entity})`)
              .join(", ");
            return `- \`${t.name}\` — primary key: ${pks || "(none)"}`;
          })
          .join("\n")
    );
  }

  if (sections.length === 0) {
    return "## Workspace context\n\n(The workspace currently has no committed definitions — this is the user's first one. Skip cross-definition consistency checks.)";
  }

  return `## Workspace context\n\nThese are the user's existing committed definitions. Use them to detect REAL cross-definition conflicts (e.g., a column whose \`dimension\` link points to a dimension whose \`data_type\` differs from the column's \`type\`).\n\n${sections.join("\n\n")}`;
}

/**
 * The string returned to the agent (Haiku) after the reviewer runs. The
 * suggestions are already rendered as interactive cards in the UI, so the
 * agent's job at this moment is to STAY OUT OF THE WAY — not to repeat,
 * summarize, or ask the user how to proceed. The cards have buttons.
 */
function agentInstruction(suggestionCount: number): string {
  if (suggestionCount === 0) {
    return [
      "The reviewer found no issues. The chat already shows a 'Review complete — no issues found.' note.",
      "Do NOT add any prose response. An automatic summary message will arrive in a moment — when it does, proceed directly to the static check step.",
    ].join(" ");
  }
  return [
    `The reviewer returned ${suggestionCount} suggestion${suggestionCount === 1 ? "" : "s"}. They are already displayed as interactive cards in the chat — the user can click ✓ or ✗ on each card directly.`,
    "STRICT RULES for your response right now:",
    "1. Do NOT list, summarize, paraphrase, or repeat the suggestions in prose. The cards already show them.",
    "2. Do NOT ask the user 'would you like to accept all / accept some / reject some' or any variant. The cards have buttons — that IS the interface.",
    "3. Either say nothing at all, or at most one short sentence like 'Please review the suggestions above.' Then STOP.",
    "4. Wait silently for the auto-summary message ('All suggestions reviewed: …') that arrives once the user finishes accepting/denying. When it arrives, proceed to the static check step.",
  ].join(" ");
}

export function createReviewDefinitionTool(getCanvasState: () => unknown) {
  return {
    description:
      "Run an AI review of the definition currently on the canvas. Reads the canvas state directly. Returns a list of one-click fixes rendered as cards in the chat. If the tool returns an empty suggestions list, the definition is clean — proceed to the next workflow step. Pass `userConstraints` to record any explicit user-stated requirements so the reviewer doesn't propose changes that contradict them.",
    inputSchema: zodSchema(
      z.object({
        kind: z
          .enum([
            "entity",
            "dimension",
            "logger_table",
            "lattik_table",
            "metric",
          ])
          .describe("The type of definition currently on the canvas"),
        userConstraints: z
          .string()
          .optional()
          .describe(
            "Optional short summary of explicit user-stated requirements from the conversation (e.g. 'Retention must stay at 90 days for compliance'; 'user_id is a string, not int64 — upstream producer confirmed'). Populate this when the user has locked down a specific choice you want the reviewer to respect. Omit when the user hasn't stated anything binding — do NOT invent constraints or paraphrase the form state back here."
          ),
      })
    ),
    execute: async (
      input: { kind: DefinitionKind; userConstraints?: string }
    ) => {
      const canvasState = getCanvasState();
      const formState = sanitizeCanvasFormState(canvasState);

      const skillId = SKILL_FOR_KIND[input.kind];
      const skillDoc = getSkillContent(skillId) ?? "";
      const reviewerPolicy = getSkillContent("reviewing-definitions") ?? "";

      // Load the workspace context in parallel with the canvas state work.
      // This gives Sonnet visibility into the user's existing entities,
      // dimensions, and tables so it can detect real cross-definition
      // conflicts instead of guessing from convention.
      let workspaceContext = "";
      try {
        workspaceContext = await buildWorkspaceContext();
      } catch (e) {
        // If the workspace lookup fails (e.g. DB hiccup), fall back to a
        // notice in the prompt rather than failing the whole review.
        workspaceContext = `## Workspace context\n\n(Failed to load existing definitions: ${
          e instanceof Error ? e.message : String(e)
        }. Skip cross-definition consistency checks for this run.)`;
      }

      const constraintsBlock = input.userConstraints?.trim()
        ? `\n\n## User-stated constraints\n\nThe user has explicitly stated the following during the conversation. Treat these as load-bearing decisions the user has made deliberately — do NOT propose changes that contradict them, even if they deviate from convention.\n\n${input.userConstraints.trim()}`
        : "";

      try {
        const result = await generateObject({
          model: gateway("anthropic/claude-sonnet-4.6"),
          schema: reviewerOutputSchema,
          system: `${reviewerPolicy}\n\n${skillDoc}`,
          prompt: `The user is authoring a ${input.kind} definition. The current canvas form state is:\n\n\`\`\`json\n${JSON.stringify(formState, null, 2)}\n\`\`\`\n\n${workspaceContext}${constraintsBlock}\n\nReview it and return actionable fixes. Use canvas form state JSON Pointer paths in your actions (the field names you see above). Remember: do NOT recommend column type changes based on convention — only flag a type if you can verify a conflict against the workspace context above. Return \`suggestions: []\` if there is nothing concrete to fix.`,
        });

        const suggestions = result.object.suggestions;
        return {
          kind: input.kind,
          suggestions,
          instruction: agentInstruction(suggestions.length),
        };
      } catch (error) {
        return {
          kind: input.kind,
          suggestions: [] as ReviewSuggestion[],
          error:
            error instanceof Error
              ? `Reviewer failed: ${error.message}`
              : "Reviewer failed with an unknown error",
          instruction:
            "The review tool failed. Tell the user briefly that the review couldn't run and ask if they want to skip review and run static checks directly.",
        };
      }
    },
  };
}
