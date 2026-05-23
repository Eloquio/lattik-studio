import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import type { NextAuthConfig } from "next-auth";

// Edge-safe NextAuth config: no database adapter, no DB driver imports. This
// is what `proxy.ts` consumes — the proxy runs on every request and must not
// drag in `postgres-js` / Drizzle, which fail to initialize in the proxy
// runtime ("pb is not a function" at runtime in Next.js 16). The full
// adapter-bound config lives in `./index.ts` and is used by API routes.
//
// The dev provider here has a no-op `authorize` because the proxy only decodes
// the JWT cookie — it never invokes `authorize`. The real DB-touching version
// lives in `./index.ts`.

const isDev = process.env.NODE_ENV === "development";

function devProviderEdgeSafe() {
  return Credentials({
    id: "dev",
    name: "Dev Login",
    credentials: {
      username: { label: "Username", type: "text" },
      password: { label: "Password", type: "password" },
    },
    async authorize() {
      return null;
    },
  });
}

export const authConfig = {
  providers: isDev ? [devProviderEdgeSafe()] : [Google],
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
} satisfies NextAuthConfig;
