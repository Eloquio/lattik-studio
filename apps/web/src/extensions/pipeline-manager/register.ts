import { registerExtension } from "../registry";
import { pipelineManagerAgent } from "./agent";

registerExtension({
  id: "pipeline-manager",
  name: "Pipeline Manager",
  description:
    "Monitor and operate the data ecosystem — Logger Tables and Airflow DAGs",
  icon: "workflow",
  agent: pipelineManagerAgent,
});
