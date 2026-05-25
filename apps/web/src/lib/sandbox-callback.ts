import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { getSandboxHmacKey } from "./sandbox-callback-env";

/**
 * Shared-secret HMAC for sandbox → app completion callbacks.
 *
 * Each task launch mints a per-attempt `callbackToken` and HKDF-derives a
 * fresh signing key from the master HMAC. The sandbox receives only the
 * derived key (in the `LATTIK_TASK_CALLBACK_KEY` env var), signs the canonical
 * string `${token}:${ok ? "1" : "0"}:${exitCode}`, and posts it back to
 * `/api/internal/sandbox-complete`. The route re-derives the same key
 * from token + master and verifies the signature before resuming the
 * workflow hook.
 *
 * Why HKDF-derive per token: a leak of the in-sandbox key only forges
 * callbacks for THAT token's tuple. The master never leaves the
 * controller process, so leaking one sandbox's env cannot be leveraged
 * into forgery against future tokens.
 */

export function deriveTokenKey(token: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(getSandboxHmacKey(), "utf8"),
      Buffer.alloc(0),
      Buffer.from(token, "utf8"),
      32
    )
  );
}

function canonicalize(token: string, ok: boolean, exitCode: number): string {
  return `${token}:${ok ? "1" : "0"}:${exitCode}`;
}

export function signCallback(
  token: string,
  ok: boolean,
  exitCode: number
): string {
  return createHmac("sha256", deriveTokenKey(token))
    .update(canonicalize(token, ok, exitCode))
    .digest("hex");
}

export function verifyCallback(
  token: string,
  ok: boolean,
  exitCode: number,
  signatureHex: string
): boolean {
  let expected: string;
  try {
    expected = signCallback(token, ok, exitCode);
  } catch {
    return false;
  }
  if (expected.length !== signatureHex.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signatureHex, "hex")
    );
  } catch {
    return false;
  }
}
