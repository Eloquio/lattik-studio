/**
 * Message widgets — the third UI primitive in the chat protocol.
 *
 * Where render-intents target named regions of a canvas surface,
 * widgets are interactive UI **attached to a specific assistant message**
 * in the chat stream itself. Examples:
 *
 *   - review-suggestions: per-card accept/reject buttons next to the
 *     assistant message that produced the review.
 *   - (future) confirm-before-destructive: yes/no gate before a
 *     dangerous tool call.
 *   - (future) disambiguation pickers, rating widgets, etc.
 *
 * Widgets carry per-message state (each widget instance has its own
 * accept/reject status, etc.); render-intents replace whole canvas
 * surfaces. Different abstraction; parallel protocol.
 *
 * Unlike `RenderIntent`, widgets have **no `surface`** — they live
 * wherever the chat client decides to render them (next to the
 * assistant's message in apps/web; as a Block Kit message in Slack;
 * etc.). And unlike render-intents, there's no widget→Spec adapter
 * because widgets are rendered directly as React components by each
 * client.
 *
 * Append-only at the schema level — adding a new widget kind is
 * additive. Renaming or restructuring an existing kind requires a
 * versioned `kind` (e.g. `review-suggestions-v2`).
 */

// ---------------------------------------------------------------------------
// review-suggestions
// ---------------------------------------------------------------------------

export interface ReviewSuggestionAction {
  /** JSON Pointer path against the canvas form state (e.g. `/description`,
   * `/user_columns/0/dimension`). The chat client applies the patch when
   * the user clicks ✓. */
  path: string;
  /** Literal final value to set at `path`. Never a placeholder, instruction,
   * or template — the LLM emits ready-to-apply values. */
  value: unknown;
}

export interface ReviewSuggestion {
  /** Stable id for the suggestion — also the key the chat client uses to
   * record per-card accept/reject decisions on the message. */
  id: string;
  /** Short imperative title (5-8 words). */
  title: string;
  /** One or two sentences explaining the fix and why it matters. */
  description: string;
  /** ≥1 patch ready to one-click apply. */
  actions: ReviewSuggestionAction[];
}

export interface ReviewSuggestionsWidget {
  kind: "review-suggestions";
  data: {
    /** The kind of definition being reviewed (entity, dimension, …). */
    definitionKind: string;
    suggestions: ReviewSuggestion[];
  };
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type MessageWidget = ReviewSuggestionsWidget;

export type MessageWidgetKind = MessageWidget["kind"];

/** Type-guard helper for clients pattern-matching widget tool results. */
export function isWidget<K extends MessageWidgetKind>(
  widget: MessageWidget,
  kind: K,
): widget is Extract<MessageWidget, { kind: K }> {
  return widget.kind === kind;
}
