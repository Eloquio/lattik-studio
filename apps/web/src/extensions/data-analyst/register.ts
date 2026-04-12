import { registerExtension } from "../registry";
import { dataAnalystAgent } from "./agent";

registerExtension({
  id: "data-analyst",
  name: "Data Analyst",
  description: "Query data with SQL, explore tables, and visualize results with charts",
  icon: "chart-bar",
  agent: dataAnalystAgent,
});
