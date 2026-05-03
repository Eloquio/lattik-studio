// The Drizzle schema lives in `@eloquio/db-schema` so apps/agent-service can
// share it. This file is a thin re-export so the existing `./schema` import
// paths across apps/web keep working without churn.
export * from "@eloquio/db-schema";
