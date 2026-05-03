import { tool, zodSchema } from "ai";
import { z } from "zod";
import { listDefinitions, getDefinitionByName } from "../lib/definitions.js";

/**
 * Definition-lifecycle tools for Data Architect.
 *
 * Real implementations this slice:
 *   - listDefinitions, getDefinition — read-only queries against the
 *     definitions table.
 *
 * Still stubs (each is its own follow-up slice — they need bigger ports):
 *   - updateDefinition — needs canvas-to-spec (~300 lines).
 *   - staticCheck — needs the validation library (4 files).
 *   - generateYaml — needs the yaml generator + canvas-to-spec.
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

export const updateDefinitionTool = tool({
  description:
    "Persist the current canvas form as a definition draft in the definitions DB. Idempotent on (kind, name) — overwrites the in-progress draft.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => noteStub(),
});

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
