import { tool, zodSchema } from "ai";
import { z } from "zod";
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

/**
 * Definition-lifecycle tools for Data Architect.
 *
 * Real implementations this slice:
 *   - listDefinitions, getDefinition — read-only queries against the
 *     definitions table.
 *   - updateDefinition — factory; takes the user id (for createdBy on
 *     insert) and a canvas-state getter. The spec is derived from the
 *     canvas form via canvasStateToSpec.
 *
 * Still stubs (each is its own follow-up slice):
 *   - staticCheck — needs the validation library (4 files).
 *   - generateYaml — needs the yaml generator + canvas-to-spec (have it).
 *   - submitPR, deleteDefinition — need the Gitea client.
 *   - reviewDefinition — needs canvas-state-aware diff rendering.
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

export const reviewDefinitionTool = tool({
  description:
    "Render a side-by-side review of the definition draft (current canvas state) versus the persisted spec, so the user can confirm what's about to be written.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => noteStub(),
});

export const staticCheckTool = tool({
  description:
    "Run the static-check validators on the current canvas form (naming, referential integrity, expression typing). Surface every error so the user can fix before continuing.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => ({ ...noteStub(), errors: [] }),
});

export const generateYamlTool = tool({
  description:
    "Render the YAML spec on the canvas as an editable, syntax-highlighted block. STOP after this and ask the user whether to submit a PR.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => noteStub(),
});

export const submitPRTool = tool({
  description:
    "Submit a Gitea PR carrying the YAML currently shown on the canvas. Reads from canvas state; do NOT pass the YAML inline.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => ({ ...noteStub(), status: "stub", prUrl: null }),
});

export const deleteDefinitionTool = tool({
  description:
    "Open a deletion PR for a definition. Specify the `name` (and `kind` if it's ambiguous across kinds).",
  inputSchema: zodSchema(
    z.object({
      name: z.string(),
      kind: definitionKindEnum.optional(),
    }),
  ),
  execute: async (input) => ({ ...noteStub(), status: "stub", input }),
});
