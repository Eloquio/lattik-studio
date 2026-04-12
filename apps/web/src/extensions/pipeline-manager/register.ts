import { registerExtension } from "../registry";
import { pipelineManagerAgent } from "./agent";

registerExtension({
  id: "pipeline-manager",
  name: "Pipeline Manager",
  description:
    "Monitor, trigger, and troubleshoot Airflow DAGs for Lattik Tables",
  icon: "workflow",
  agent: pipelineManagerAgent,
});
