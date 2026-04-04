export { JsonRenderer } from "./renderer";
export type { RenderSpec, ElementSpec, JsonRenderComponentProps } from "./types";
export { registerComponent, getComponent, hasComponent } from "./registry";

// Register built-in components
import { registerComponent } from "./registry";
import { Heading } from "./components/heading";
import { DataTable } from "./components/data-table";
import { TextInput } from "./components/text-input";
import { Select } from "./components/select";
import { Checkbox } from "./components/checkbox";
import { Section } from "./components/section";
import { ColumnList } from "./components/column-list";
import { MockedTablePreview } from "./components/mocked-table-preview";
import { ReviewCard } from "./components/review-card";
import { StatusBadge } from "./components/status-badge";
import { ExpressionEditor } from "./components/expression-editor";

registerComponent("Heading", { component: Heading });
registerComponent("CanvasTitle", { component: Heading }); // backward compat
registerComponent("DataTable", { component: DataTable });
registerComponent("TextInput", { component: TextInput });
registerComponent("Select", { component: Select });
registerComponent("Checkbox", { component: Checkbox });
registerComponent("Section", { component: Section });
registerComponent("ColumnList", { component: ColumnList });
registerComponent("MockedTablePreview", { component: MockedTablePreview });
registerComponent("ReviewCard", { component: ReviewCard });
registerComponent("StatusBadge", { component: StatusBadge });
registerComponent("ExpressionEditor", { component: ExpressionEditor });
