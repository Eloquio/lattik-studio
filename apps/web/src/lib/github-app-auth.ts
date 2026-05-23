import { createSign } from "node:crypto";

/**
 * GitHub App authentication helper.
 *
 * Two-step auth flow:
 *   1. Sign a short-lived (≤10 min) JWT with the App's private key. The
 *      JWT identifies the App itself, not any installation.
 *   2. POST that JWT to `/app/installations/{id}/access_tokens` to mint
 *      an installation access token (1 h TTL) scoped to the repos the
 *      App is installed on.
 *
 * The installation token is cached on `globalThis` so HMR/dev reloads
 * and concurrent requests share it. We refresh 5 min before expiry so a
 * long-running request never sees an expired token mid-flight.
 *
 * Private key formatting: Vercel and many shells turn real newlines in
 * env vars into the literal two-char sequence `\n`. We normalize both
 * forms so the user can paste the PEM file's contents directly without
 * worrying about escape rules.
 */

const APP_ID = process.env.GITHUB_APP_ID ?? "";
const PRIVATE_KEY_RAW = process.env.GITHUB_APP_PRIVATE_KEY ?? "";
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID ?? "";

const PRIVATE_KEY = PRIVATE_KEY_RAW.replace(/\\n/g, "\n");

interface CachedToken {
  token: string;
  expiresAt: number;
}

const globalForGhAuth = globalThis as unknown as {
  ghInstallationToken?: CachedToken;
};

function base64url(input: Buffer | string): string {
  const b = typeof input === "string" ? Buffer.from(input) : input;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signAppJwt(): string {
  if (!APP_ID || !PRIVATE_KEY) {
    throw new Error(
      "GitHub App auth misconfigured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (PEM contents).",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // `iat` is set 60s in the past to tolerate small clock skew between
  // us and GitHub. `exp` is 9 min — the 10-min cap is hard, so we leave
  // buffer for the request itself.
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: APP_ID,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(PRIVATE_KEY);
  return `${signingInput}.${base64url(signature)}`;
}

export async function getInstallationToken(): Promise<string> {
  if (!INSTALLATION_ID) {
    throw new Error(
      "GitHub App auth misconfigured: set GITHUB_APP_INSTALLATION_ID (visible in the App's installation URL).",
    );
  }

  const cached = globalForGhAuth.ghInstallationToken;
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }

  const jwt = signAppJwt();
  const res = await fetch(
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to mint GitHub App installation token: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  globalForGhAuth.ghInstallationToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  return data.token;
}
