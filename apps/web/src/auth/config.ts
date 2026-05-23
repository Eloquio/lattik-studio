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
    // OAuth allowlist. `AUTH_ALLOWED_EMAILS` accepts a comma-separated list of
    // entries in two shapes: a literal email (`alice@example.com`) matches that
    // exact address; an entry starting with `@` (`@example.com`) matches any
    // email at that domain. If the env var is unset or empty we allow all —
    // setting it is the opt-in to enforcement.
    signIn({ user, account }) {
      if (account?.provider === "credentials") return true;

      const raw = process.env.AUTH_ALLOWED_EMAILS;
      if (!raw) return true;

      const allowlist = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (allowlist.length === 0) return true;

      const email = user.email?.toLowerCase();
      if (!email) return false;

      return allowlist.some((entry) =>
        entry.startsWith("@") ? email.endsWith(entry) : email === entry,
      );
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
