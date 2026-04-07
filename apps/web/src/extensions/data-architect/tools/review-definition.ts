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

const REVIEWER_SYSTEM = `You are the senior data architect reviewing a Lattik Studio definition that another user is currently authoring on a canvas form. Your single job is to propose ACTIONABLE FIXES — concrete one-click changes that improve the definition.

## Output rules

1. Each suggestion MUST include \`actions[]\` with at least one entry.
2. Each action's \`value\` MUST be the literal final value to set, never a placeholder, instruction, or template variable. If you cannot decide on a literal value, OMIT the suggestion.
3. \`actions[].path\` is a JSON Pointer against the canvas form state shown to you below — use the field names exactly as they appear in that JSON, including \`/user_columns\` (not \`/columns\`) for logger tables.
4. Limit yourself to the most important 3-5 fixes. Quality over quantity.
5. If the definition has no actionable issues, return \`suggestions: []\`. Do not pad with filler.

## What NOT to file as a suggestion

- Open-ended observations ("the table currently has only one column", "the description is empty")
- Questions or "consider X" notes ("consider adding a session_id column", "you might want…")
- Compliments or confirmations that something is correct
- Anything where the right value depends on the user's intent rather than something you can decide for them
- Style preferences without a clear improvement

### Specifically: column types

Column \`type\` choices (\`int64\`, \`string\`, \`timestamp\`, etc.) reflect the upstream data shape that the user controls — you cannot see the actual data, so you cannot know which type is correct. **Do NOT suggest changing a column's type based on industry convention** ("user IDs are usually strings", "amounts should be doubles", etc.). Only suggest a type change if you can VERIFY a conflict against another definition the user has already committed:

- The column has a \`dimension\` link, the dimension exists in the workspace context below, and the dimension's \`data_type\` differs from the column's \`type\`. Then suggest setting the column type to match the dimension.
- The column is a primary-key column in a Lattik Table that references an entity, the entity exists in the workspace context below, and the entity's \`id_type\` differs. Same fix shape.

If neither of those verifiable conflicts holds, leave the type alone.

## Workspace context

The user's existing committed definitions (entities, dimensions, tables) will be provided to you in the user prompt below under "Workspace context". Use them to detect REAL cross-definition inconsistencies — type mismatches against linked dimensions, references to non-existent entities, dimension links to dimensions that don't exist, etc. Those are exactly the kind of verifiable, high-signal fixes you should be filing.

When in doubt, omit. Empty \`suggestions: []\` is a valid and frequently correct answer.

## Reference: skill document for this definition kind

The skill document below describes the fields, validation rules, and conventions for this kind of definition. Use it to identify what's missing, malformed, or improvable.`;

export function createReviewDefinitionTool(getCanvasState: () => unknown) {
  return {
    description:
      "Run an AI review of the definition currently on the canvas. Reads the canvas state directly. Returns a list of one-click fixes rendered as cards in the chat. If the tool returns an empty suggestions list, the definition is clean — proceed to the next workflow step.",
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
      })
    ),
    execute: async (input: { kind: DefinitionKind }) => {
      const canvasState = getCanvasState();
      const formState = sanitizeCanvasFormState(canvasState);

      const skillId = SKILL_FOR_KIND[input.kind];
      const skillDoc = getSkillContent(skillId) ?? "";

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

      try {
        const result = await generateObject({
          model: gateway("anthropic/claude-sonnet-4.6"),
          schema: reviewerOutputSchema,
          system: `${REVIEWER_SYSTEM}\n\n${skillDoc}`,
          prompt: `The user is authoring a ${input.kind} definition. The current canvas form state is:\n\n\`\`\`json\n${JSON.stringify(formState, null, 2)}\n\`\`\`\n\n${workspaceContext}\n\nReview it and return actionable fixes. Use canvas form state JSON Pointer paths in your actions (the field names you see above). Remember: do NOT recommend column type changes based on convention — only flag a type if you can verify a conflict against the workspace context above. Return \`suggestions: []\` if there is nothing concrete to fix.`,
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
