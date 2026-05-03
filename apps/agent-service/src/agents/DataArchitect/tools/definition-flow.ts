import { tool, zodSchema } from "ai";
import { z } from "zod";

/**
 * Phase 1 stubs for the definition-lifecycle tools the Data Architect
 * uses to ship a YAML spec to the pipelines repo:
 *   reviewDefinition → staticCheck → updateDefinition → generateYaml → submitPR
 *
 * Plus deletion / listing helpers (deleteDefinition, listDefinitions,
 * getDefinition) that don't pass through the render flow.
 *
 * Real implementations move from apps/web/src/extensions/data-architect/
 * tools/ in a follow-up slice. They touch the definitions table
 * (packages/db-schema), Gitea (PR creation), and the YAML generator.
 */

const noteStub = (note = "Real implementation pending — moves from apps/web in a follow-up slice.") =>
  ({ stub: true, note });

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

export const updateDefinitionTool = tool({
  description:
    "Persist the current canvas form as a definition draft in the definitions DB. Idempotent on (kind, name) — overwrites the in-progress draft.",
  inputSchema: zodSchema(z.object({})),
  execute: async () => noteStub(),
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
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .optional(),
    }),
  ),
  execute: async (input) => ({ ...noteStub(), status: "stub", input }),
});

export const listDefinitionsTool = tool({
  description:
    "List all definitions, optionally filtered by kind. Returns name + status (draft / pending_review / merged / pending_deletion).",
  inputSchema: zodSchema(
    z.object({
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .optional(),
    }),
  ),
  execute: async () => ({ ...noteStub(), definitions: [] }),
});

export const getDefinitionTool = tool({
  description:
    "Fetch one definition's full spec by name. Returns the spec, status, and any open PR url.",
  inputSchema: zodSchema(
    z.object({
      name: z.string(),
      kind: z
        .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
        .optional(),
    }),
  ),
  execute: async (input) => ({ ...noteStub(), input, definition: null }),
});
