/**
 * Thin wrapper over the `kubectl` CLI for studio → cluster operations.
 *
 * Studio needs cluster-write capability to create worker Deployments/Secrets.
 * During local dev we shell out to the host's `kubectl` binary (which reads
 * ~/.kube/config) rather than using @kubernetes/client-node. Rationale:
 *   - kubectl is already a dev prereq.
 *   - Every other piece of tooling in this repo also shells out.
 *   - Swapping to the SDK later is a single-file change.
 *
 * When studio is eventually deployed off-host, replace `runKubectl` with an
 * in-cluster ServiceAccount client; the public helpers (applyManifest,
 * deleteResource, buildWorkerManifests) keep their signatures.
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

/**
 * Invoke kubectl. Pipes `input` on stdin when given (used with
 * `kubectl apply -f -`). Never inherits the parent's stdio; always captures
 * stdout/stderr so callers can surface structured errors to users.
 */
export function runKubectl(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("kubectl", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new KubectlError(args, code ?? -1, stdout, stderr));
    });
    if (input !== undefined) {
      proc.stdin.end(input);
    } else {
      proc.stdin.end();
    }
  });
}

/** `kubectl apply -f -` piping the manifest on stdin. */
export async function applyManifest(manifest: string): Promise<void> {
  await runKubectl(["apply", "-f", "-"], manifest);
}

/** `kubectl delete <kind> <name> -n <ns> --ignore-not-found`. */
export async function deleteResource(
  kind: string,
  name: string,
  namespace: string,
): Promise<void> {
  await runKubectl([
    "delete",
    kind,
    name,
    "-n",
    namespace,
    "--ignore-not-found",
  ]);
}

export const WORKERS_NAMESPACE = "workers";
export const WORKER_IMAGE = "lattik/agent-worker:dev";

/**
 * Port the studio dev server binds to on the host. The pod reaches it via
 * host.docker.internal (works on Docker Desktop for Mac; Linux kind needs
 * an explicit hostAliases entry which is out of scope for this plan).
 */
export const TASK_API_URL_FROM_POD = "http://host.docker.internal:3737";

export function workerDeploymentName(workerId: string) {
  return `agent-worker-${workerId}`;
}

export function workerSecretName(workerId: string) {
  return `agent-worker-${workerId}-creds`;
}

/**
 * Render the Secret + Deployment YAML for a cluster-mode worker. Returned
 * as one multi-document string ready for `kubectl apply -f -`.
 *
 * Caller is responsible for opening an abort path if apply fails — see
 * createWorker in lib/actions/workers.ts for the rollback sequence.
 */
export function buildWorkerManifests({
  workerId,
  name,
  secret,
}: {
  workerId: string;
  name: string;
  secret: string;
}): string {
  const deploymentName = workerDeploymentName(workerId);
  const secretName = workerSecretName(workerId);
  // Sanitize the display name for the label value — k8s label values are
  // constrained to [a-z0-9A-Z.-]. The raw name sits on metadata.annotations
  // (no length/charset limit) so the UI can still show what the user typed.
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 63);
  return [
    `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${WORKERS_NAMESPACE}
  labels:
    app: agent-worker
    worker-id: ${workerId}
type: Opaque
stringData:
  LATTIK_WORKER_ID: ${workerId}
  LATTIK_WORKER_SECRET: ${secret}`,
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${WORKERS_NAMESPACE}
  labels:
    app: agent-worker
    worker-id: ${workerId}
    worker-name: ${safeName}
  annotations:
    lattik.io/worker-display-name: ${JSON.stringify(name)}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: agent-worker
      worker-id: ${workerId}
  template:
    metadata:
      labels:
        app: agent-worker
        worker-id: ${workerId}
    spec:
      containers:
        - name: agent-worker
          image: ${WORKER_IMAGE}
          imagePullPolicy: Never
          envFrom:
            - secretRef:
                name: ${secretName}
          env:
            - name: TASK_API_URL
              value: "${TASK_API_URL_FROM_POD}"
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "512Mi"`,
  ].join("\n---\n");
}
