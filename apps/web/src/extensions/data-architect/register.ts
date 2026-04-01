import { registerExtension } from "../registry";
import { dataArchitectAgent } from "../agents/data-architect";
import { DataArchitectCanvas } from "./canvas/data-architect-canvas";

registerExtension({
  id: "data-architect",
  name: "Data Architect",
  description: "Design pipeline architectures: Logger Tables, Lattik Tables, and Canonical Dimensions",
  icon: "blocks",
  agent: dataArchitectAgent,
  canvas: DataArchitectCanvas,
});
