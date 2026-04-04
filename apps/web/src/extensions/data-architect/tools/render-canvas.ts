import { zodSchema } from "ai";
import { z } from "zod";

export const renderCanvasTool = {
  description:
    "Render a visual component on the canvas panel. Supports json-render components: Heading, DataTable, TextInput, Select, Checkbox, Section, ColumnList, MockedTablePreview, ReviewCard, StatusBadge, ExpressionEditor, and legacy components: CanvasTitle, PipelineView.",
  inputSchema: zodSchema(
    z.object({
      specJson: z
        .string()
        .describe(
          'JSON string of the full RenderSpec: { root: string, elements: Record<string, { type: string, props: Record<string, unknown>, children?: string[] }>, state?: Record<string, unknown> }'
        ),
    })
  ),
  execute: async (input: { specJson: string }) => {
    try {
      const spec = JSON.parse(input.specJson);
      return { spec, rendered: true };
    } catch {
      return { error: "Invalid JSON in specJson", rendered: false };
    }
  },
};
