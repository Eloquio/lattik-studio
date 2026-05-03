import type { Spec } from "@json-render/core";
import type { PrSubmittedIntent } from "@eloquio/render-intents";

/**
 * Project a PrSubmittedIntent into the json-render Spec apps/web's
 * canvas registry already understands. The `PRSubmittedCard` component
 * renders a clickable PR link, the branch name, and the list of files
 * that landed in the PR.
 */
export function prSubmittedToSpec(intent: PrSubmittedIntent): Spec {
  const { definitionKind, name, prNumber, prUrl, branch, files } = intent.data;
  return {
    root: "main",
    elements: {
      main: {
        type: "PRSubmittedCard",
        props: {
          kind: definitionKind,
          name,
          prNumber,
          prUrl,
          branch,
          files,
        },
        children: [],
      },
    },
    state: {},
  } as Spec;
}
