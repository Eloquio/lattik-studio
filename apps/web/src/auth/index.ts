import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";

import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { upsertDevAdmin } from "@/db/dev-user";

const isDev = process.env.NODE_ENV === "development";

function devProvider() {
  return Credentials({
    id: "dev",
    name: "Dev Login",
    credentials: {
      username: { label: "Username", type: "text" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      if (credentials.username !== "admin" || credentials.password !== "admin") {
        return null;
      }
      return upsertDevAdmin(getDb());
    },
  });
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const db = getDb();
  return {
    adapter: DrizzleAdapter(db, {
      usersTable: schema.users,
      accountsTable: schema.accounts,
      sessionsTable: schema.sessions,
      verificationTokensTable: schema.verificationTokens,
    }),
    providers: isDev ? [devProvider()] : [Google],
    session: { strategy: "jwt" },
    pages: {
      signIn: "/sign-in",
    },
    callbacks: {
      authorized({ auth }) {
        return !!auth?.user;
      },
      jwt({ token, user }) {
        if (user) token.id = user.id;
        return token;
      },
      session({ session, token }) {
        if (token.id) session.user.id = token.id as string;
        return session;
      },
    },
  };
});
