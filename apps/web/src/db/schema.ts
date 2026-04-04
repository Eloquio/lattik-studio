import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  ]
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const conversations = pgTable("conversation", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  messages: jsonb("messages").notNull().$type<unknown[]>().default([]),
  canvasState: jsonb("canvasState").$type<unknown>(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export type DefinitionKind =
  | "entity"
  | "dimension"
  | "logger_table"
  | "lattik_table"
  | "metric";

export type DefinitionStatus = "draft" | "pending_review" | "merged";

export const definitions = pgTable("definition", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  kind: text("kind").$type<DefinitionKind>().notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  spec: jsonb("spec").notNull().$type<unknown>(),
  status: text("status").$type<DefinitionStatus>().notNull().default("draft"),
  prUrl: text("prUrl"),
  prMergedAt: timestamp("prMergedAt", { mode: "date" }),
  createdBy: text("createdBy").references(() => users.id),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export const agents = pgTable("agent", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  icon: text("icon").notNull(),
  category: text("category").notNull(),
  type: text("type").$type<"first-party" | "third-party">().notNull(),
  config: jsonb("config").$type<{
    system_prompt?: string;
    knowledge?: string[];
    tools?: string[];
  }>(),
  authorId: text("authorId").references(() => users.id),
  published: boolean("published").notNull().default(true),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export const userAgents = pgTable(
  "user_agent",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agentId")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    enabledAt: timestamp("enabledAt", { mode: "date" }).notNull().defaultNow(),
  },
  (ua) => [
    primaryKey({ columns: [ua.userId, ua.agentId] }),
  ]
);

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
  ]
);
