import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const catalog = defineCatalog(schema, {
  components: {
    // --- Layout ---
    AnalystLayout: {
      props: z.object({}),
      description:
        "Root layout for Data Analyst canvas. Renders children vertically with spacing.",
    },

    // --- SQL ---
    SqlEditor: {
      props: z.object({}),
      description:
        "Editable SQL editor with syntax highlighting. Reads/writes state at 'sql'.",
    },

    // --- Query feedback ---
    QueryStats: {
      props: z.object({}),
      description:
        "Compact stats badge showing row count, duration, and truncation warning. Reads from state: rowCount, duration, truncated.",
    },
    QueryError: {
      props: z.object({}),
      description:
        "Error display for failed queries. Reads from state: queryError.",
    },

    // --- Results ---
    ResultsTable: {
      props: z.object({}),
      description:
        "Paginated data table for query results. Reads from state: columns, rows.",
    },

    // --- Charts ---
    BarChart: {
      props: z.object({}),
      description:
        "Bar chart visualization. Reads from state: columns, rows, chart (type, xColumn, yColumns, title).",
    },
    LineChart: {
      props: z.object({}),
      description:
        "Line chart visualization. Reads from state: columns, rows, chart.",
    },
    AreaChart: {
      props: z.object({}),
      description:
        "Area chart visualization. Reads from state: columns, rows, chart.",
    },
    PieChart: {
      props: z.object({}),
      description:
        "Pie chart visualization. Reads from state: columns, rows, chart.",
    },
    ScatterPlot: {
      props: z.object({}),
      description:
        "Scatter plot visualization. Reads from state: columns, rows, chart.",
    },
  },
  actions: {},
});
