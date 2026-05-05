/**
 * Minimal kubectl shell-out for tools that need to apply manifests.
 *
 * Host-mode worker only — uses the host's `kubectl` binary, which reads
 * ~/.kube/config. Cluster-mode workers don't have kubectl baked in and would
 * need a different mechanism (in-cluster k8s API client + ServiceAccount).
 */

import { spawn } from "node:child_process";

export class KubectlError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(
      `kubectl ${args.join(" ")} exited ${exitCode}: ${stderr || stdout}`.trim(),
    );
    this.name = "KubectlError";
  }
}

export function runKubectl(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("kubectl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new KubectlError(args, code ?? -1, stdout, stderr));
    });
    if (input !== undefined) proc.stdin.end(input);
    else proc.stdin.end();
  });
}

export async function applyManifest(manifest: string): Promise<void> {
  await runKubectl(["apply", "-f", "-"], manifest);
}

/**
 * Wait for a Deployment to become Available (Available condition = True).
 * Throws on timeout or kubectl failure.
 */
export async function waitForDeploymentAvailable(
  namespace: string,
  name: string,
  timeoutSeconds = 120,
): Promise<void> {
  await runKubectl([
    "wait",
    "--for=condition=Available",
    `--timeout=${timeoutSeconds}s`,
    `-n`,
    namespace,
    `deployment/${name}`,
  ]);
}
