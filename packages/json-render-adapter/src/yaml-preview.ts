import type { Spec } from "@json-render/core";
import type { YamlPreviewIntent } from "@eloquio/render-intents";

/**
 * Project a YamlPreviewIntent into the json-render Spec the apps/web
 * canvas registry already understands. The `YamlEditor` component reads
 * its files + active_file from `state` (so the user's edits survive
 * re-streams), and the registry pipes the editor's onChange back into
 * the shared canvas-state store.
 */
export function yamlPreviewToSpec(intent: YamlPreviewIntent): Spec {
  const { definitionKind, name, files } = intent.data;
  return {
    root: "main",
    elements: {
      main: { type: "YamlEditor", props: {}, children: [] },
    },
    state: {
      kind: definitionKind,
      name,
      files: files.map((f, i) => ({
        _key: `yamlfile_${i}`,
        path: f.path,
        content: f.content,
      })),
      active_file: 0,
    },
  } as Spec;
}
