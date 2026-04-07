import { zodSchema } from "ai";
import { z } from "zod";
import type { Spec } from "@json-render/core";
import type { DefinitionKind } from "@/db/schema";
import { generateYamlFiles } from "../yaml-generator";
import {
  canvasStateToSpec,
  getDefinitionNameFromCanvas,
} from "../canvas-to-spec";

/**
 * generateYaml renders the YAML representation of the current canvas
 * definition into a YamlEditor on the canvas. The user can then manually edit
 * the YAML before submitting a PR. submitPR reads the (possibly edited) YAML
 * back from canvas state — this tool is the bridge between the form-based
 * editing flow and the file-based PR flow.
 *
 * Output shape mirrors the render*Form tools: `{kind, spec, instruction}`. The
 * chat-panel watcher recognizes this tool's name and applies `output.spec` as
 * the new canvas spec.
 */
export function createGenerateYamlTool(getCanvasState: () => unknown) {
  return {
    description:
      "Generate YAML files from the current canvas definition and display them on the canvas in an editable, syntax-highlighted YAML editor. Reads the spec from canvas form state — do NOT pass a spec, name, or specJson. The user may then manually adjust the YAML before submitting a PR. Run this AFTER static checks pass and BEFORE submitPR.",
    inputSchema: zodSchema(
      z.object({
        kind: z
          .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
          .describe("The type of definition currently on the canvas"),
      })
    ),
    execute: async (input: { kind: DefinitionKind }) => {
      const canvasState = getCanvasState();
      const name = getDefinitionNameFromCanvas(canvasState);
      if (!name) {
        return {
          error:
            "Canvas form has no name field set — fill it in before generating YAML.",
        };
      }
      const definitionSpec = canvasStateToSpec(input.kind, canvasState);
      const files = generateYamlFiles(input.kind, name, definitionSpec);

      const spec: Spec = {
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
  };
}
