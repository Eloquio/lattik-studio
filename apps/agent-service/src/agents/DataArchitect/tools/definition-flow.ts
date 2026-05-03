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
import { validate } from "../lib/validation/index.js";
import { generateYamlFiles } from "../lib/yaml-generator.js";

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
    execute: async (input: { kind: z.infer<typeof definitionKindEnum> }) => {
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

      // Phase 2 will replace this with a render-intent. For now we emit the
      // same json-render Spec apps/web already knows how to display, typed
      // as `unknown` to avoid pulling @json-render/core into agent-service.
      const spec: unknown = {
        root: "main",
        elements: {
          main: { type: "YamlEditor", props: {}, children: [] },
        },
        state: {
          kind: input.kind,
          name,
          files: files.map((f, i) => ({
            _key: `yamlfile_${i}`,
            path: f.path,
            content: f.content,
          })),
          active_file: 0,
        },
      };
      return {
        kind: input.kind,
        spec,
        instruction:
          "The YAML editor is now on the canvas with the generated YAML pre-filled. The user can review, edit, and add files before creating the PR. Tell the user briefly that the YAML is ready and ask if they'd like to create the PR. Do NOT call submitPR until the user explicitly confirms.",
      };
    },
  });
}

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
