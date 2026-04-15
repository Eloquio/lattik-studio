import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import * as schema from "@/db/schema";

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

      const db = getDb();
      const email = "admin@lattik.local";
      const existing = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email));

      if (existing.length > 0) return existing[0];

      const [user] = await db
        .insert(schema.users)
        .values({ email, name: "Lattik Admin" })
        .returning();
      return user;
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
