import { registerExtension } from "../registry";
import { dataArchitectAgent } from "./agent";

registerExtension({
  id: "data-architect",
  name: "Data Architect",
  description: "Design pipeline architectures: Logger Tables, Lattik Tables, and Canonical Dimensions",
  icon: "blocks",
  agent: dataArchitectAgent,
});
