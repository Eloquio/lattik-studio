import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const FIRST_PARTY_AGENTS = [
  {
    id: "data-architect",
    name: "Data Architect",
    description:
      "Design pipeline architectures: Logger Tables, Lattik Tables, and Canonical Dimensions. Build and visualize data pipelines for your Data Lake.",
    icon: "blocks",
    category: "Data Architecture",
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
