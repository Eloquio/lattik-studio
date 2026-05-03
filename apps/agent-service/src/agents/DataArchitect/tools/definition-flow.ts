import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { YamlPreviewIntent } from "@eloquio/render-intents";
import {
  listDefinitions,
  getDefinitionByName,
  createDefinition,
  updateDefinition as updateDefinitionRow,
} from "../lib/definitions.js";
import {
  canvasStateToSpec,
  getDefinitionNameFromCanvas,
} from "../lib/canvas-to-spec.js";
import { validate } from "../lib/validation/index.js";
import { generateYamlFiles } from "../lib/yaml-generator.js";

/**
 * Definition-lifecycle tools for Data Architect.
 *
 * Real now: listDefinitions, getDefinition, updateDefinition, staticCheck,
 * generateYaml. submitPR and deleteDefinition live in their own files
 * (each is bigger). Only reviewDefinition is still stubbed — it needs a
 * canvas-state-aware diff renderer that doesn't exist yet.
 */

const definitionKindEnum = z.enum([
  "entity",
  "dimension",
  "logger_table",
  "lattik_table",
  "metric",
]);

const noteStub = (note = "Real implementation pending — bigger port in a follow-up slice.") =>
  ({ stub: true, note });

// ---------------------------------------------------------------------------
// Real read tools
// ---------------------------------------------------------------------------

export const listDefinitionsTool = tool({
  description:
    "List existing definitions, optionally filtered by kind. Use this to check what entities, tables, dimensions, and metrics already exist.",
  inputSchema: zodSchema(
    z.object({
      kind: definitionKindEnum.optional().describe("Filter by definition kind"),
    }),
  ),
  execute: async (input: { kind?: z.infer<typeof definitionKindEnum> }) => {
    const defs = await listDefinitions({ kind: input.kind });
    return {
      count: defs.length,
      definitions: defs.map((d) => ({
        id: d.id,
        kind: d.kind,
        name: d.name,
        version: d.version,
        status: d.status,
        updatedAt: d.updatedAt,
      })),
    };
  },
});

export const getDefinitionTool = tool({
  description:
    "Fetch a specific definition by kind and name. Returns the full spec. Use this when the user wants to view or update an existing definition.",
  inputSchema: zodSchema(
    z.object({
      kind: definitionKindEnum.describe("The type of definition"),
      name: z.string().describe("The name of the definition"),
    }),
  ),
  execute: async (input: {
    kind: z.infer<typeof definitionKindEnum>;
    name: string;
  }) => {
    const def = await getDefinitionByName(input.kind, input.name);
    if (!def) {
      return { found: false, message: `No ${input.kind} named '${input.name}' found` };
    }
    return {
      found: true,
      id: def.id,
      kind: def.kind,
      name: def.name,
      version: def.version,
      status: def.status,
      spec: def.spec,
      prUrl: def.prUrl,
      updatedAt: def.updatedAt,
    };
  },
});

// ---------------------------------------------------------------------------
// Stubs — still pending real implementations
// ---------------------------------------------------------------------------

export interface CreateUpdateDefinitionToolOptions {
  /** The user creating/owning the draft — flows into definitions.createdBy. */
  userId: string;
  getCanvasState: () => unknown;
}

export function createUpdateDefinitionTool(opts: CreateUpdateDefinitionToolOptions) {
  return tool({
    description:
      "Save or update a definition in the database as a draft, using the current canvas form state as the source of truth. The name and spec are read directly from the canvas — do NOT pass them. If a definition with the same kind and name exists, it will be updated; otherwise a new draft is created.",
    inputSchema: zodSchema(
      z.object({
        kind: definitionKindEnum.describe(
          "The type of definition currently on the canvas",
        ),
      }),
    ),
    execute: async (input: { kind: z.infer<typeof definitionKindEnum> }) => {
      const canvasState = opts.getCanvasState();
      const name = getDefinitionNameFromCanvas(canvasState);
      if (!name) {
        return { error: "Canvas form has no name field set — fill it in before saving." };
      }
      const spec = canvasStateToSpec(input.kind, canvasState);
      try {
        const existing = await getDefinitionByName(input.kind, name);
        if (existing) {
          const updated = await updateDefinitionRow(existing.id, { spec });
          return { action: "updated", id: updated.id, name, kind: input.kind };
        }
        const created = await createDefinition({
          kind: input.kind,
          name,
          spec,
          userId: opts.userId,
        });
        return { action: "created", id: created.id, name, kind: input.kind };
      } catch (error) {
        if (error instanceof Error && error.message.includes("unique")) {
          const existing = await getDefinitionByName(input.kind, name);
          if (existing) {
            const updated = await updateDefinitionRow(existing.id, { spec });
            return { action: "updated", id: updated.id, name, kind: input.kind };
          }
        }
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

// reviewDefinition lives in its own file (review-definition.ts) — it makes
// an LLM call (Sonnet via generateObject) and returns a typed
// ReviewSuggestionsWidget rather than a render-intent. See the
// MessageWidget protocol in @eloquio/render-intents/widgets.

export interface CreateStaticCheckToolOptions {
  getCanvasState: () => unknown;
}

export function createStaticCheckTool(opts: CreateStaticCheckToolOptions) {
  return tool({
    description:
      "Run static validation checks on the definition currently rendered on the canvas. Reads the canvas form state directly — do NOT pass a spec. Validates naming conventions, required fields, referential integrity, and expression syntax. Returns pass/fail with error details.",
    inputSchema: zodSchema(
      z.object({
        kind: definitionKindEnum.describe(
          "The type of definition currently on the canvas",
        ),
      }),
    ),
    execute: async (input: { kind: z.infer<typeof definitionKindEnum> }) => {
      const spec = canvasStateToSpec(input.kind, opts.getCanvasState());
      return await validate(input.kind, spec);
    },
  });
}

export interface CreateGenerateYamlToolOptions {
  getCanvasState: () => unknown;
}

export function createGenerateYamlTool(opts: CreateGenerateYamlToolOptions) {
  return tool({
    description:
      "Generate YAML files from the current canvas definition and display them on the canvas in an editable, syntax-highlighted YAML editor. Reads the spec from canvas form state — do NOT pass a spec, name, or specJson. The user may then manually adjust the YAML before submitting a PR. Run this AFTER static checks pass and BEFORE submitPR.",
    inputSchema: zodSchema(
      z.object({
        kind: definitionKindEnum.describe(
          "The type of definition currently on the canvas",
        ),
      }),
    ),
    execute: async (
      input: { kind: z.infer<typeof definitionKindEnum> },
    ): Promise<YamlPreviewIntent | { error: string }> => {
      const canvasState = opts.getCanvasState();
      const name = getDefinitionNameFromCanvas(canvasState);
      if (!name) {
        return {
          error:
            "Canvas form has no name field set — fill it in before generating YAML.",
        };
      }
      const definitionSpec = canvasStateToSpec(input.kind, canvasState);
      const files = generateYamlFiles(input.kind, name, definitionSpec);

      return {
        kind: "yaml-preview",
        surface: "yaml",
        data: {
          definitionKind: input.kind,
          name,
          files,
        },
      };
    },
  });
}

// submitPR / deleteDefinition live in their own files — each is substantial
// (200+ lines apiece). Re-export through the index pattern from chat.post.ts
// so callers see the same module surface.
