/**
 * Database seed.
 *
 * Currently a no-op. The previous first-party agent seeding went away with
 * the agent table — chat specialists are now registered in code under
 * `apps/web/src/extensions/`, and the worker side dispatches Planner /
 * Executor agents that load skills from `apps/web/src/skills/`. Re-add seed
 * data here if/when something durable needs it.
 */

async function seed() {
  console.log("Nothing to seed.");
}

seed().catch(console.error);
