import { getDb } from "./index";
import { upsertDevAdmin, DEV_ADMIN_USER_ID } from "./dev-user";

async function seed() {
  const db = getDb();
  await upsertDevAdmin(db);
  console.log(`Seeded dev admin user (${DEV_ADMIN_USER_ID}).`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
