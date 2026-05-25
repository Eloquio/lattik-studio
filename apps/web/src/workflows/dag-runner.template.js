// Sandbox-side runner template.
//
// IMPORTANT: This file is NOT executed in the host process. It is read as
// a string by buildRunnerJs() in task-steps.ts and written verbatim to
// `runner.js` inside a Vercel Sandbox, where it runs as the entrypoint.
//
// Do NOT import from this repo's lib/ — the sandbox has only Node built-ins
// and whatever bundle.js the launch step writes alongside this file. Do NOT
// add template substitutions: every dynamic value comes from process.env so
// the host keeps this as plain readable JS (lint-checkable, type-aware via
// JSDoc, unit-testable in isolation).

/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("crypto");
const http = require("http");

const fnName = process.env.LATTIK_TASK_FN_NAME;
const ctx = JSON.parse(process.env.LATTIK_TASK_CTX);
const timeoutMs = Number(process.env.LATTIK_TASK_TIMEOUT_MS);
const callbackUrl = process.env.LATTIK_TASK_CALLBACK_URL;
// 64-char hex of the 32-byte HKDF-derived signing key for THIS token.
// The master callback secret never enters the sandbox; a leak of this key
// can only forge a callback for this one token's tuple.
const callbackKey = Buffer.from(process.env.LATTIK_TASK_CALLBACK_KEY, "hex");
const callbackToken = process.env.LATTIK_TASK_CALLBACK_TOKEN;
const logToken = process.env.LATTIK_TASK_LOG_TOKEN || "";
const logPort = Number(process.env.LATTIK_TASK_LOG_PORT || 3000);
// Short-lived Vercel OIDC token minted in launchTaskSandbox. Sent on the
// callback POST so it passes Deployment Protection via the project's
// default `(this project)` Trusted Sources rule.
const oidcToken = process.env.LATTIK_TASK_OIDC_TOKEN || "";

// ---------------- Sensitive-value redaction ----------------
//
// Snapshot the env-var values that must never leave the sandbox via stdout
// or stderr (live SSE stream OR captured-and-persisted-to-Blob bytes). The
// patched write below scrubs every occurrence with "***" before the line
// reaches either path.
//
// Sorted longest-first so a value that is a substring of another (rare but
// possible) gets replaced first. Length >= 8 prevents over-redaction when
// an env var is unset or trivially short.
const SENSITIVE_VALUES = [
  process.env.LATTIK_TASK_OIDC_TOKEN,
  process.env.LATTIK_TASK_CALLBACK_KEY,
  process.env.LATTIK_TASK_CALLBACK_TOKEN,
  process.env.LATTIK_TASK_LOG_TOKEN,
]
  .filter((v) => typeof v === "string" && v.length >= 8)
  .sort((a, b) => b.length - a.length);

function redact(text) {
  if (SENSITIVE_VALUES.length === 0) return text;
  let out = text;
  for (const v of SENSITIVE_VALUES) {
    if (out.includes(v)) out = out.split(v).join("***");
  }
  return out;
}

// ---------------- Live log server ----------------

const sseClients = new Set();

const RING_MAX_BYTES = 64 * 1024;
const ring = [];
let ringBytes = 0;

function pushRing(stream, line) {
  const entry = { stream, line };
  ring.push(entry);
  ringBytes += line.length;
  while (ringBytes > RING_MAX_BYTES && ring.length > 1) {
    const removed = ring.shift();
    ringBytes -= removed.line.length;
  }
}

function broadcast(stream, line) {
  pushRing(stream, line);
  const payload =
    "event: line\ndata: " + JSON.stringify({ stream, line }) + "\n\n";
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // Will be cleaned up on close.
    }
  }
}

// Patch stdout/stderr so we mirror to SSE clients AND redact every known
// sensitive value before any byte leaves the process. The original write
// path receives the redacted bytes too — the captured-stdout-to-Blob path
// sees only the redacted form.
function patchStream(s, name) {
  const orig = s.write.bind(s);
  let pending = "";
  s.write = function (chunk, enc, cb) {
    let outBytes;
    try {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const redacted = redact(text);
      pending += redacted;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        broadcast(name, pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      outBytes = redacted;
    } catch {
      outBytes = chunk;
    }
    return orig(outBytes, typeof outBytes === "string" ? "utf8" : enc, cb);
  };
}
patchStream(process.stdout, "stdout");
patchStream(process.stderr, "stderr");

function timingSafeStrEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", "http://x");
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }
  if (url.pathname !== "/logs") {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end("not found");
    return;
  }
  const token = url.searchParams.get("t") || "";
  if (!logToken || !timingSafeStrEq(token, logToken)) {
    res.writeHead(403, { "Access-Control-Allow-Origin": "*" });
    res.end("forbidden");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.write(
    "event: open\ndata: " + JSON.stringify({ ts: Date.now() }) + "\n\n"
  );
  for (const { stream, line } of ring) {
    res.write(
      "event: line\ndata: " +
        JSON.stringify({ stream, line }) +
        "\n\n"
    );
  }
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});
server.on("error", (err) => {
  process.stderr.write(
    "[runner] log server error: " + (err && err.message) + "\n"
  );
});
try {
  server.listen(logPort, "0.0.0.0");
} catch (e) {
  process.stderr.write(
    "[runner] log server listen failed: " + (e && e.message) + "\n"
  );
}

function closeLogServer() {
  for (const res of sseClients) {
    try {
      res.write("event: end\ndata: {}\n\n");
      res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  try {
    server.close();
  } catch {
    /* ignore */
  }
}

// ---------------- Completion callback ----------------

function sign(token, ok, exitCode) {
  return crypto
    .createHmac("sha256", callbackKey)
    .update(token + ":" + (ok ? "1" : "0") + ":" + exitCode)
    .digest("hex");
}

async function postCallback(ok, exitCode, errorMessage, stderrTail) {
  const body = {
    token: callbackToken,
    ok,
    exitCode,
    signature: sign(callbackToken, ok, exitCode),
  };
  if (errorMessage) body.errorMessage = String(errorMessage).slice(-2000);
  if (stderrTail) body.stderrTail = String(stderrTail).slice(-2000);
  const headers = { "content-type": "application/json" };
  if (oidcToken) {
    headers["x-vercel-trusted-oidc-idp-token"] = oidcToken;
  }
  for (let i = 0; i < 3; i += 1) {
    try {
      // 10s per-attempt timeout: without this, a receiver that accepts the
      // TCP connection but never finalizes the response hangs fetch
      // indefinitely. Three hangs would exceed the sandbox lifetime, leaving
      // the workflow watchdog to fire with a null exitCode.
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
    } catch {
      // fall through to retry
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
}

(async () => {
  let exitCode = 0;
  let errorMessage;
  let timer;
  let timedOut = false;
  try {
    const tasks = require("./bundle.js");
    const fn = tasks[fnName] || (tasks.default && tasks.default[fnName]);
    if (typeof fn !== "function") {
      errorMessage = "Task fn '" + fnName + "' not found in bundle";
      exitCode = 2;
    } else {
      timer = setTimeout(() => {
        timedOut = true;
        errorMessage =
          "Task '" + fnName + "' exceeded " + timeoutMs + "ms";
        exitCode = 124;
        closeLogServer();
        postCallback(false, exitCode, errorMessage).finally(() =>
          process.exit(exitCode)
        );
      }, timeoutMs);
      try {
        await fn(ctx);
      } catch (err) {
        errorMessage = err && err.stack ? err.stack : String(err);
        exitCode = 1;
      }
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    if (timer) clearTimeout(timer);
    errorMessage = err && err.stack ? err.stack : String(err);
    exitCode = 1;
  }
  if (timedOut) return;
  closeLogServer();
  await postCallback(exitCode === 0, exitCode, errorMessage);
  process.exit(exitCode);
})();
