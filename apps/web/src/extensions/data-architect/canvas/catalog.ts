import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const catalog = defineCatalog(schema, {
  components: {
    // --- Layout ---
    Section: {
      props: z.object({
        title: z.string().optional(),
      }),
      description: "Vertical section with optional title. Place child elements inside.",
    },
    Heading: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().optional(),
      }),
      description: "Heading with title and optional subtitle. Do NOT use before composite forms (LoggerTableForm, EntityForm, etc.) — they render their own title.",
    },

    // --- Form fields ---
    TextInput: {
      props: z.object({
        label: z.string().optional(),
        field: z.string().describe("State key to bind the value to"),
        placeholder: z.string().optional(),
        required: z.boolean().optional(),
        multiline: z.boolean().optional(),
        variant: z
          .enum(["default", "title", "subtitle"])
          .optional()
          .describe("title = large inline, subtitle = small inline, default = labeled input"),
        defaultValue: z.string().optional(),
      }),
      description:
        "Text input. Reads/writes state at the `field` key. Use variant=title for table names, variant=subtitle for descriptions.",
    },
    Select: {
      props: z.object({
        label: z.string(),
        field: z.string(),
        options: z.array(z.object({ value: z.string(), label: z.string() })),
        required: z.boolean().optional(),
        defaultValue: z.string().optional(),
      }),
      description: "Dropdown select. Reads/writes state at the `field` key.",
    },
    Checkbox: {
      props: z.object({
        label: z.string(),
        field: z.string(),
        defaultValue: z.boolean().optional(),
      }),
      description: "Checkbox. Reads/writes boolean state at the `field` key.",
    },

    // --- Data display ---
    DataTable: {
      props: z.object({
        title: z.string().optional(),
        columns: z.array(z.object({ key: z.string(), label: z.string() })),
        rows: z.array(z.record(z.string(), z.string())),
      }),
      description: "Read-only data table.",
    },
    MockedTablePreview: {
      props: z.object({
        title: z.string().optional(),
        columns: z.array(z.object({ name: z.string(), type: z.string() })),
        rowCount: z.number().optional(),
      }),
      description: "Preview table with generated mock data based on column types.",
    },

    // --- Domain-specific ---
    ColumnList: {
      props: z.object({
        label: z.string().optional(),
        field: z.string(),
        typeOptions: z.array(z.string()).optional(),
      }),
      description:
        "Editable column list (name + type). Stores array in state at `field`.",
    },
    ReviewCard: {
      props: z.object({
        suggestionId: z.string(),
        title: z.string(),
        description: z.string(),
      }),
      description: "Accept/deny card for AI review suggestions.",
    },
    StatusBadge: {
      props: z.object({
        status: z.string(),
        label: z.string().optional(),
        step: z.string().optional(),
      }),
      description:
        "Pipeline status badge (draft, reviewing, checks-passed, checks-failed, pr-submitted, merged).",
    },

    // --- Composite forms ---
    // These render complete definition forms. All data lives in spec.state.
    // IMPORTANT: Each form renders its own title. Never add a Heading before a composite form.
    LoggerTableForm: {
      props: z.object({}),
      description:
        "Logger table definition form. Renders its own title — never pair with a Heading. State: name, description, retention, dedup_window, user_columns[].",
    },
    EntityForm: {
      props: z.object({}),
      description:
        "Entity definition form. Renders its own title — never pair with a Heading. State: name, description, id_field, id_type.",
    },
    DimensionForm: {
      props: z.object({}),
      description:
        "Dimension definition form. Renders its own title — never pair with a Heading. State: name, description, entity, source_table, source_column, data_type.",
    },
    MetricForm: {
      props: z.object({}),
      description:
        "Metric definition form. Renders its own title — never pair with a Heading. State: name, description, calculations[].",
    },
    LattikTableForm: {
      props: z.object({}),
      description:
        "Lattik table definition form. Renders its own title — never pair with a Heading. State: name, description, retention, primary_key[], column_families[], derived_columns[].",
    },
    YamlEditor: {
      props: z.object({}),
      description:
        "Multi-file YAML editor with syntax highlighting. Renders one tab per generated YAML file and lets the user manually edit the contents before submitting a PR. State: kind, name, files[] ({path, content}), active_file (number index).",
    },
  },
  actions: {},
});
