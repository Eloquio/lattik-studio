/**
 * Bare env reader for the sandbox callback master key. Lives in its own
 * file so it can be imported from workflow modules — the Workflow build
 * forbids `node:crypto` in workflow modules, but `process.env` is fine.
 *
 * The companion file `sandbox-callback.ts` imports `node:crypto` for the
 * HKDF derivation and HMAC verify; only host code (route handlers, steps)
 * may import that one.
 */
export function getSandboxHmacKey(): string {
  const key = process.env.LATTIK_SANDBOX_HMAC_KEY;
  if (!key) {
    throw new Error(
      "LATTIK_SANDBOX_HMAC_KEY is not configured. Refusing to sign or verify sandbox callbacks."
    );
  }
  if (key.length < 32) {
    throw new Error(
      "LATTIK_SANDBOX_HMAC_KEY is shorter than 32 chars. Use `openssl rand -hex 32`."
    );
  }
  return key;
}
