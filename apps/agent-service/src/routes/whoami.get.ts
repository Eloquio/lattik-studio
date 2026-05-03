import { defineEventHandler } from "h3";

/**
 * Returns the resolved auth context for the calling request. Useful as a
 * smoke test for the trusted-client bridge — a working call returns the
 * client id (verified) and user id (asserted by the client) the request
 * authenticated as.
 */
export default defineEventHandler((event) => {
  const auth = event.context.auth;
  if (!auth) {
    // Belt-and-braces — the auth middleware should have either attached this
    // or rejected the request. If we get here, something's mis-wired.
    return { error: "auth context missing" };
  }
  return { clientId: auth.clientId, userId: auth.userId };
});
