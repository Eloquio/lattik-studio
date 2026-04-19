import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const FIRST_PARTY_AGENTS = [
  {
    id: "data-architect",
    name: "Data Architect",
    description:
      "Design and manage pipeline concepts: Entities, Dimensions, Logger Tables, Lattik Tables, and Metrics. Owns all deletion flows — route any delete/drop/remove request (for a table, definition, or pipeline concept) to this agent.",
    icon: "blocks",
    category: "Data Architecture",
    type: "first-party" as const,
    published: true,
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description:
      "Query data with SQL, explore tables, and visualize results with charts. Runs read-only queries against Trino and creates bar, line, area, pie, and scatter charts. Does NOT delete tables or definitions — route deletions to the Data Architect.",
    icon: "chart-bar",
    category: "Data Analysis",
    type: "first-party" as const,
    published: true,
  },
  {
    id: "pipeline-manager",
    name: "Pipeline Manager",
    description:
      "Monitor, trigger, and troubleshoot Airflow DAGs for Lattik Tables. View run history, inspect task failures, retry jobs, and manage backfills.",
    icon: "workflow",
    category: "Pipeline Operations",
    type: "first-party" as const,
    published: true,
  },
];

async function seed() {
  const client = postgres(process.env.DATABASE_URL!);
  const db = drizzle(client, { schema });

  for (const agent of FIRST_PARTY_AGENTS) {
    await db
      .insert(schema.agents)
      .values(agent)
      .onConflictDoUpdate({
        target: schema.agents.id,
        set: {
          name: agent.name,
          description: agent.description,
          icon: agent.icon,
          category: agent.category,
          updatedAt: new Date(),
        },
      });
  }

  console.log(`Seeded ${FIRST_PARTY_AGENTS.length} agent(s)`);
  await client.end();
}

seed().catch(console.error);
