import { generateText, gateway, tool, zodSchema, Output } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@eloquio/db-schema";
import type {
  Entity,
  Dimension,
  LoggerTable,
  LattikTable,
} from "../lib/schema.js";
import type { ReviewSuggestionsWidget } from "@eloquio/render-intents";
import { sanitizeCanvasFormState } from "../lib/canvas-to-spec.js";
import {
  loadMergedEntities,
  loadMergedDimensions,
  loadMergedTables,
} from "../lib/validation/referential.js";

/**
 * `reviewDefinition` — runs an LLM review of the definition currently on
 * the canvas and returns a typed `ReviewSuggestionsWidget` (parallel
 * MessageWidget protocol — see `packages/render-intents/src/widgets.ts`).
 * The chat client renders the suggestion cards inline next to the
 * assistant's message; per-card decisions persist as `data-reviewDecisions`
 * parts on the message itself.
 *
 * The reviewer policy is inlined below. The previous implementation in
 * apps/web also embedded a kind-specific skill document (e.g.
 * `defining-entity.md`) in the prompt for additional context — those
 * prose skills haven't been migrated to agent-service yet, so this slice
 * runs without them. Quality regression but recoverable; a follow-up
 * brings the skill docs in as inline strings or a build-time manifest.
 */

const REVIEWING_DEFINITIONS_POLICY = `# Reviewing a Definition

You are the senior data architect reviewing a Lattik Studio definition that another user is currently authoring on a canvas form. Your single job is to propose ACTIONABLE FIXES — concrete one-click changes that improve the definition.

## Output rules

1. Each suggestion MUST include \`actions[]\` with at least one entry.
2. Each action's \`value\` MUST be the literal final value to set, never a placeholder, instruction, or template variable. If you cannot decide on a literal value, OMIT the suggestion.
3. \`actions[].path\` is a JSON Pointer against the canvas form state shown to you below — use the field names exactly as they appear in that JSON, including \`/user_columns\` (not \`/columns\`) for logger tables.
4. Limit yourself to the most important 3-5 fixes. Quality over quantity.
5. If the definition has no actionable issues, return \`suggestions: []\`. Do not pad with filler.

## Logger-table column field reference

The form state for a logger column \`user_columns[i]\` accepts these fields and ONLY these fields:

- \`name\` (string) — snake_case column name
- \`type\` (enum: \`string\` | \`int32\` | \`int64\` | \`float\` | \`double\` | \`boolean\` | \`timestamp\` | \`date\` | \`bytes\` | \`json\`)
- \`description\` (string, optional)
- \`dimension\` (string, optional) — name of an existing dimension to link to
- \`classification\` (object, optional) — sensitivity flags. Set ONE OR MORE of these booleans to mark the column:
  - \`classification.pii\` — personally identifiable info (user IDs, names, emails, IPs, device IDs)
  - \`classification.phi\` — protected health info
  - \`classification.financial\` — payment, account, balance, transaction data
  - \`classification.credentials\` — secrets, tokens, keys, passwords
- \`tags\` (string array, optional) — free-form metadata only. NOT for classification.

**For PII / PHI / financial / credentials, set the classification flag, NEVER \`tags\`.** The canvas renders classification flags as red/yellow/etc. badges next to the column name; \`tags\` are free-form metadata that don't appear in the column row. A suggestion that puts \`"pii"\` into \`tags\` is silently ineffective from the user's point of view.

Action shape examples:
- Tag a column as PII: \`{ "path": "/user_columns/0/classification/pii", "value": true }\`
- Tag as both PII and credentials: two separate actions, one per flag.
- Add a description: \`{ "path": "/user_columns/0/description", "value": "..." }\`

## What NOT to file as a suggestion

- Open-ended observations ("the table currently has only one column", "the description is empty")
- Questions or "consider X" notes ("consider adding a session_id column", "you might want…")
- Compliments or confirmations that something is correct
- Anything where the right value depends on the user's intent rather than something you can decide for them
- Style preferences without a clear improvement
- **Removing an existing PII tag / classification from any field.** PII flags are intentional, conservative governance decisions made by the author — treat them as load-bearing even if the field name looks innocuous (session IDs, hashed tokens, etc. are frequently tagged as PII on purpose). You may suggest *adding* a PII tag to an untagged field that looks sensitive, but never propose removing one.
- **Removing an existing \`dimension\` binding from a column.** A dimension link encodes a deliberate semantic join — breaking it silently corrupts downstream metrics and models. You may suggest *adding* a dimension link where one is missing, or *changing* a column's \`type\` to match its linked dimension (per the rules below), but never propose dropping the link itself.
- **Changing the default 30-day retention on a logger table.** 30d is the product-wide default and is a deliberate policy choice — extending, shortening, or otherwise changing \`retention_days\` based on generic analytics conventions ("page-view data usually needs 90d", "30d is too short for funnel analysis", etc.) is out of scope for review. Leave \`retention_days\` alone unless the user has explicitly set a non-default value that is internally inconsistent with something else in the definition.
- **Table-level tags on a logger table.** Tags only exist at the column level (\`/user_columns/<i>/tags\`) — there is no table-level \`tags\` field in the schema. Do NOT propose adding a tag on the table itself to document non-default retention, dedup window, ownership, lifecycle, or any other table-wide property. If the intent is to document a non-default choice, the right home is the table \`description\`, not a tag.

### Specifically: column types

Column \`type\` choices (\`int64\`, \`string\`, \`timestamp\`, etc.) reflect the upstream data shape that the user controls — you cannot see the actual data, so you cannot know which type is correct. **Do NOT suggest changing a column's type based on industry convention** ("user IDs are usually strings", "amounts should be doubles", etc.). Only suggest a type change if you can VERIFY a conflict against another definition the user has already committed:

- The column has a \`dimension\` link, the dimension exists in the workspace context below, and the dimension's \`data_type\` differs from the column's \`type\`. Then suggest setting the column type to match the dimension.
- The column is a primary-key column in a Lattik Table that references an entity, the entity exists in the workspace context below, and the entity's \`id_type\` differs. Same fix shape.

If neither of those verifiable conflicts holds, leave the type alone.

## Workspace context

The user's existing committed definitions (entities, dimensions, tables) will be provided to you in the user prompt below under "Workspace context". Use them to detect REAL cross-definition inconsistencies — type mismatches against linked dimensions, references to non-existent entities, dimension links to dimensions that don't exist, etc. Those are exactly the kind of verifiable, high-signal fixes you should be filing.

## User-stated constraints

The user prompt may also include a "User-stated constraints" section. When present, those are explicit choices the user has made during the conversation (often justifying a non-default value — e.g. a specific retention window for compliance, a known upstream column type). Treat them as binding: do NOT file suggestions that reverse, shorten, or otherwise contradict a stated constraint. A suggestion that contradicts a user constraint is a regression, not an improvement — omit it. You may still file unrelated suggestions that don't touch constrained fields.

When in doubt, omit. Empty \`suggestions: []\` is a valid and frequently correct answer.`;

// Schema for the structured output we ask Sonnet to produce. Strict
// (especially `actions.min(1)`) — this is the contract that makes
// Sonnet's output safely turn into a typed ReviewSuggestionsWidget.
const reviewerOutputSchema = z.object({
  suggestions: z
    .array(
      z.object({
        id: z.string().describe("Unique snake_case suggestion ID, e.g. 'missing_desc'"),
        title: z.string().describe("Short imperative title (5-8 words), e.g. 'Add a description'"),
        description: z.string().describe("One or two sentences explaining the fix and why it matters"),
        actions: z
          .array(
            z.object({
              path: z.string().describe(
                "JSON Pointer path against the canvas form state, e.g. '/description' or '/user_columns/0/dimension'",
              ),
              value: z.unknown().describe(
                "The literal final value to set at this path — never a placeholder, instruction, or template",
              ),
            }),
          )
          .min(1)
          .describe(
            "REQUIRED. At least one concrete patch with a literal value, ready to apply with one click.",
          ),
      }),
    )
    .describe(
      "List of actionable fixes. Empty array means the definition is clean and ready to proceed.",
    ),
});

const definitionKindEnum = z.enum([
  "entity",
  "dimension",
  "logger_table",
  "lattik_table",
  "metric",
]);

async function buildWorkspaceContext(): Promise<string> {
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
          .map(
            (e: Entity) =>
              `- \`${e.name}\` — id_field: \`${e.id_field}\`, id_type: \`${e.id_type}\``,
          )
          .join("\n"),
    );
  }

  if (dimensions.length > 0) {
    sections.push(
      "### Dimensions\n" +
        dimensions
          .map(
            (d: Dimension) =>
              `- \`${d.name}\` — entity: \`${d.entity}\`, source: \`${d.source_table}.${d.source_column}\`, data_type: \`${d.data_type}\``,
          )
          .join("\n"),
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
          .join("\n"),
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
          .join("\n"),
    );
  }

  if (sections.length === 0) {
    return "## Workspace context\n\n(The workspace currently has no committed definitions — this is the user's first one. Skip cross-definition consistency checks.)";
  }

  return `## Workspace context\n\nThese are the user's existing committed definitions. Use them to detect REAL cross-definition conflicts (e.g., a column whose \`dimension\` link points to a dimension whose \`data_type\` differs from the column's \`type\`).\n\n${sections.join("\n\n")}`;
}

export interface CreateReviewDefinitionToolOptions {
  getCanvasState: () => unknown;
}

type ReviewToolResult =
  | ReviewSuggestionsWidget
  | {
      kind: "review-suggestions";
      data: { definitionKind: string; suggestions: [] };
      error: string;
    };

export function createReviewDefinitionTool(opts: CreateReviewDefinitionToolOptions) {
  return tool({
    description:
      "Run an AI review of the definition currently on the canvas. Reads the canvas state directly. Returns a list of one-click fixes rendered as cards in the chat. If the tool returns an empty suggestions list, the definition is clean — proceed to the next workflow step. Pass `userConstraints` to record any explicit user-stated requirements so the reviewer doesn't propose changes that contradict them.",
    inputSchema: zodSchema(
      z.object({
        kind: definitionKindEnum.describe(
          "The type of definition currently on the canvas",
        ),
        userConstraints: z
          .string()
          .optional()
          .describe(
            "Optional short summary of explicit user-stated requirements from the conversation (e.g. 'Retention must stay at 90 days for compliance'). Populate this when the user has locked down a specific choice you want the reviewer to respect. Omit when the user hasn't stated anything binding — do NOT invent constraints.",
          ),
      }),
    ),
    execute: async (input: {
      kind: DefinitionKind;
      userConstraints?: string;
    }): Promise<ReviewToolResult> => {
      const canvasState = opts.getCanvasState();
      const formState = sanitizeCanvasFormState(canvasState);

      let workspaceContext = "";
      try {
        workspaceContext = await buildWorkspaceContext();
      } catch (e) {
        workspaceContext = `## Workspace context\n\n(Failed to load existing definitions: ${
          e instanceof Error ? e.message : String(e)
        }. Skip cross-definition consistency checks for this run.)`;
      }

      const constraintsBlock = input.userConstraints?.trim()
        ? `\n\n## User-stated constraints\n\nThe user has explicitly stated the following during the conversation. Treat these as load-bearing decisions the user has made deliberately — do NOT propose changes that contradict them, even if they deviate from convention.\n\n${input.userConstraints.trim()}`
        : "";

      try {
        const result = await generateText({
          model: gateway("anthropic/claude-sonnet-4.6"),
          output: Output.object({ schema: reviewerOutputSchema }),
          system: REVIEWING_DEFINITIONS_POLICY,
          prompt: `The user is authoring a ${input.kind} definition. The current canvas form state is:\n\n\`\`\`json\n${JSON.stringify(formState, null, 2)}\n\`\`\`\n\n${workspaceContext}${constraintsBlock}\n\nReview it and return actionable fixes. Use canvas form state JSON Pointer paths in your actions (the field names you see above). Remember: do NOT recommend column type changes based on convention — only flag a type if you can verify a conflict against the workspace context above. Return \`suggestions: []\` if there is nothing concrete to fix.`,
        });

        return {
          kind: "review-suggestions",
          data: {
            definitionKind: input.kind,
            suggestions: result.output.suggestions,
          },
        };
      } catch (error) {
        return {
          kind: "review-suggestions",
          data: { definitionKind: input.kind, suggestions: [] },
          error:
            error instanceof Error
              ? `Reviewer failed: ${error.message}`
              : "Reviewer failed with an unknown error",
        };
      }
    },
  });
}
