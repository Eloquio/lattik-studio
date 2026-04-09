# Local Airflow

[Apache Airflow](https://airflow.apache.org) 3.2.0 running in the same kind cluster as everything else, with `KubernetesExecutor` so each task runs in its own pod. Used for orchestrating pipelines locally without standing up a separate compose stack or pointing at a hosted Airflow.

## What's in the stack

| Component | Role | Image | Port (in cluster) |
|---|---|---|---|
| **api-server** | FastAPI HTTP server. Serves the UI, the v2 REST API, and the execution API that worker pods call back into. Replaces Airflow 2.x's `webserver`. | `apache/airflow:3.2.0` | `8080` |
| **scheduler** | Decides what runs when. Spawns worker pods for queued task instances via the Kubernetes API. | `apache/airflow:3.2.0` | — |
| **dag-processor** | Parses DAG files on disk and writes serialized DAGs to the metadata DB. Mandatory in Airflow 3 (was embedded in the scheduler in 2.x). | `apache/airflow:3.2.0` | — |
| **airflow-init** (Job) | One-shot: creates the `airflow` database in the existing postgres, then runs `airflow db migrate`. | `apache/airflow:3.2.0` + `postgres:16-alpine` initContainer | — |
| **worker pods** | Spawned on demand by the scheduler. Run a single task, post results back to the api-server's execution API, exit. | `apache/airflow:3.2.0` (driven by `pod_template.yaml`) | — |

The metadata DB is **not** a separate pod — it's an `airflow` database inside the existing `postgres` Service ([`k8s/postgres.yaml`](../k8s/postgres.yaml)). The init Job creates it idempotently before running migrations.

## Architecture

```
                                          ┌──────────────────────────────┐
                                          │        kind cluster          │
                                          │                              │
   browser ──── http://localhost:8088 ──▶ │  airflow-api-server :8080    │
                  (NodePort 30888)        │   (FastAPI: UI + v2 + exec)  │
                                          │           │  ▲               │
                                          │           │  │ JWT-signed    │
                                          │           │  │ execution API │
                                          │           ▼  │               │
                                          │     ┌─────────────┐          │
                                          │     │  postgres   │◀─────┐   │
                                          │     │  (airflow   │      │   │
                                          │     │   database) │      │   │
                                          │     └─────────────┘      │   │
                                          │           ▲              │   │
                                          │           │              │   │
                                          │  ┌────────┴───────┐ ┌────┴─┐ │
                                          │  │   scheduler    │ │ dag- │ │
                                          │  │                │ │ proc │ │
                                          │  └────────┬───────┘ └──────┘ │
                                          │           │ creates           │
                                          │           ▼                  │
                                          │  ┌────────────────┐          │
                                          │  │ worker pod 1   │          │
                                          │  │ worker pod 2   │          │
                                          │  │ ...            │          │
                                          │  └────────────────┘          │
                                          └──────────────────────────────┘

   /var/lib/lattik/airflow-dags ─┐
                                 ├─ hostPath ──▶ /opt/airflow/dags   (all components)
   /var/lib/lattik/airflow-logs ─┘                /opt/airflow/logs
```

A few things about this picture worth knowing:

- **Workers do not talk to postgres directly.** Airflow 3 routed all task↔metadata-DB traffic through the api-server's `/execution/` endpoint. Workers authenticate with a JWT signed by `AIRFLOW__API_AUTH__JWT_SECRET`. This is the single biggest behavioral change from 2.x and the most common source of "worker started but immediately died" confusion if the secret isn't propagated everywhere.
- **The dag-processor is its own deployment.** In Airflow 2.x the scheduler also parsed DAG files. In 3.x that's now a separate process; you can't run Airflow without it. The processor's only output is rows in the `serialized_dag` table — once it writes those, the scheduler reads them from the DB without ever touching the file.
- **All four pods (api-server, scheduler, dag-processor, workers) hostPath-mount the same DAG dir.** The dag-processor is what *parses* them, but workers also need them on disk to import the DAG file at task execution time, and the api-server uses them to render code in the UI.
- **The `airflow` and `lattik_studio` databases coexist in the same postgres pod.** They share the cluster but not the schema — there's no FK between Airflow's metadata and the app's tables. This is deliberate: Airflow's schema is owned by the Airflow upgrade tooling, not by Drizzle.

## Bringing it up

```bash
# Just Airflow (assumes the cluster + postgres are already up)
pnpm airflow:start

# Or as part of the full dev env
pnpm dev:up
```

`airflow:start` is a chained `kubectl apply` + waits:

1. `kubectl apply -f k8s/airflow.yaml` — applies RBAC, Secret, ConfigMaps, init Job, the three Deployments, and the api-server NodePort Service.
2. `kubectl wait --for=condition=complete job/airflow-init` — blocks until the `create-db` initContainer (postgres-alpine) creates the `airflow` database and the main container's `airflow db migrate` finishes. Typical: 30–60s on a cold cache, ~10s once images are local.
3. `kubectl wait --for=condition=ready pod -l app=airflow-api-server` — blocks until the api-server's `/api/v2/monitor/health` probe returns 200. Typical: 60–90s after the init job finishes (DB connection pool, schema load, FastAPI startup).

To tear it down without touching anything else:

```bash
pnpm airflow:stop
```

This deletes everything in [`k8s/airflow.yaml`](../k8s/airflow.yaml) — Deployments, Service, init Job, ConfigMaps, Secret, RBAC. The `airflow` database in postgres is **not** dropped, so a subsequent `pnpm airflow:start` will reuse the existing schema and DAG history. To start completely fresh, see [Upgrades and resets](#upgrades-and-resets).

## DAG authoring workflow

DAGs come from a hostPath mount: `/var/lib/lattik/airflow-dags/` on your laptop is bind-mounted into every Airflow pod at `/opt/airflow/dags`. The dag-processor scans that directory on a loop and writes parsed DAGs to the metadata DB; the api-server reads from the DB to render the UI. **No pod restart is required** to pick up a new or modified DAG — the processor's poll interval is short (a few seconds) and you'll see the DAG appear in the UI shortly after you save the file.

The repo ships a sample DAG at [`airflow/dags/example_dag.py`](../airflow/dags/example_dag.py) that runs two tasks (`print_date` → `say_hello`) under `KubernetesExecutor` to prove the worker pod path is healthy.

The fastest way to set up live editing is to symlink the repo dir into the host bind-mount so anything you commit is automatically visible to Airflow:

```bash
# One-time setup (ensure the bind dir exists and is yours)
sudo mkdir -p /var/lib/lattik/airflow-dags
sudo chown -R "$USER" /var/lib/lattik/airflow-dags

# Symlink each DAG file (or the whole dir, depending on your taste)
ln -sf "$(pwd)/projects/lattik-studio/airflow/dags"/*.py /var/lib/lattik/airflow-dags/
```

After that, edit DAGs in `projects/lattik-studio/airflow/dags/`, save, refresh the UI. The dag-processor logs (`kubectl logs -l app=airflow-dag-processor -f`) will show the file being re-parsed.

**When you DO need a restart:**
- Adding or upgrading a Python package the DAG imports — the import happens inside the worker pod, which is built from the worker image. New deps require a custom image (see [Adding providers and dependencies](#adding-providers-and-dependencies)).
- Changing pod template fields (e.g. mounting a new volume) — the scheduler re-reads the template on next task launch, but in-flight workers keep the old spec.
- Changing any `AIRFLOW__*` env var on the api-server / scheduler / dag-processor — `kubectl rollout restart deploy/airflow-api-server deploy/airflow-scheduler deploy/airflow-dag-processor`.

## Auth and the UI

[`k8s/airflow.yaml`](../k8s/airflow.yaml) sets `AIRFLOW__CORE__AUTH_MANAGER` to `SimpleAuthManager` and `AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_ALL_ADMINS=True`. The result: the login page accepts any credentials (or none — just click Sign In) and grants admin access. **This is local-dev only.** SimpleAuthManager is documented as not suitable for production; the lattik-studio app talks to Airflow via the v2 REST API with token auth, not by fronting the UI publicly, so this is a deliberate trade-off for fast iteration.

UI: <http://localhost:8088> (NodePort 30888 → host 8088, mapped in [`k8s/kind-config.yaml`](../k8s/kind-config.yaml)).

## Adding providers and dependencies

The bare `apache/airflow:3.2.0` image ships almost no providers. To talk to Trino, MinIO, the Kubernetes API from inside a task, or really anything other than the standard library, you need to extend the image.

**Don't use `_PIP_ADDITIONAL_REQUIREMENTS`.** It's a convenience env var that runs `pip install` on every pod startup. It works for a one-off prototype, but: (a) every worker pod pulls and installs again, adding 10–60s of cold-start latency per task; (b) it bypasses the lockfile, so you can't reproduce failures; (c) network flakiness will fail tasks for reasons unrelated to your DAG. The sibling [`projects/testenv`](../../testenv) project uses this pattern, and it's the main thing we should *not* port over.

**The right pattern is a custom image.** Roughly:

```dockerfile
# k8s/airflow/Dockerfile  (sketch — not yet committed)
FROM apache/airflow:3.2.0
USER airflow
RUN pip install --no-cache-dir \
      apache-airflow-providers-trino==5.* \
      apache-airflow-providers-amazon==9.*
```

Build and side-load it into kind so the kubelet doesn't try to pull it from a registry:

```bash
docker build -t lattik/airflow:3.2.0-providers k8s/airflow
kind load docker-image lattik/airflow:3.2.0-providers --name lattik
```

Then update [`k8s/airflow.yaml`](../k8s/airflow.yaml) — every place that says `apache/airflow:3.2.0` (the four Deployments + the init Job + the pod template ConfigMap + `AIRFLOW__KUBERNETES_EXECUTOR__WORKER_CONTAINER_REPOSITORY`/`_TAG`) — and `kubectl rollout restart deploy/airflow-api-server deploy/airflow-scheduler deploy/airflow-dag-processor`.

This is fiddly enough that when we actually need providers we should consider extracting the image tag into a kustomize patch or a `make`-style script. Not worth it yet.

## Upgrades and resets

**Upgrading Airflow patch versions** (e.g. 3.2.0 → 3.2.1):

The schema is stable across patch releases. Bump the image tag everywhere in [`k8s/airflow.yaml`](../k8s/airflow.yaml), `pnpm airflow:stop && pnpm airflow:start`. The init Job's `airflow db migrate` is a no-op if the schema is already at head; it'll exit clean and the new pods come up against the existing DB.

**Upgrading Airflow minor versions** (e.g. 3.2.x → 3.3.x):

Same procedure — `db migrate` handles minor-version schema bumps. Apache's compatibility policy is "you can always migrate forward within a major version." Read the release notes for any breaking config changes, but the manifest dance is identical to a patch upgrade.

**Upgrading Airflow major versions** (e.g. 2.x → 3.x):

Non-trivial. The 2→3 jump in particular has breaking changes to executor config, the auth manager, the webserver→api-server split, and the worker connectivity model (workers no longer talk to postgres directly). For local dev, the fastest path is **drop the database and re-init**:

```bash
pnpm airflow:stop
kubectl exec -it deploy/postgres -- psql -U lattik -d lattik_studio -c 'DROP DATABASE IF EXISTS airflow'
# bump image tags + any config in k8s/airflow.yaml
pnpm airflow:start    # init job recreates the DB and runs db migrate against the new schema
```

You lose DAG run history, connections, and variables — fine for local dev, not a thing you'd do in prod. For prod migrations the [official upgrade guide](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html) is the source of truth.

**Wiping just Airflow's state without touching the cluster:**

```bash
pnpm airflow:stop
kubectl exec -it deploy/postgres -- psql -U lattik -d lattik_studio -c 'DROP DATABASE IF EXISTS airflow'
sudo rm -rf /var/lib/lattik/airflow-logs/*    # optional — just for tidiness
pnpm airflow:start
```

DAG files in `/var/lib/lattik/airflow-dags/` are not touched.

## Troubleshooting

**`http://localhost:8088` doesn't respond**

Almost always the kind port mapping. kind only reads `extraPortMappings` at cluster-creation time, so adding `8088` to [`k8s/kind-config.yaml`](../k8s/kind-config.yaml) only takes effect after `pnpm dev:down && pnpm dev:up`. Confirm with:

```bash
docker ps --filter name=lattik-control-plane --format '{{.Ports}}'
```

If you don't see `0.0.0.0:8088->30888/tcp`, the cluster is on an old config. Either recreate the cluster, or as a quick workaround: `kubectl port-forward svc/airflow-api-server 8088:8080`.

**`airflow-init` Job fails with `database "airflow" does not exist` or similar**

The `create-db` initContainer didn't finish before the main `airflow-init` container started. Look at both:

```bash
kubectl logs job/airflow-init -c create-db
kubectl logs job/airflow-init -c airflow-init
```

The `create-db` container waits on `pg_isready` so it shouldn't race, but if postgres was in the middle of a restart at the moment Airflow was applied, the readiness loop may bail before postgres is actually accepting connections. Re-running `pnpm airflow:start` is usually enough — the Job is idempotent.

**Worker pod starts but immediately fails with 401 / 403 hitting the api-server**

JWT secret mismatch. The worker's `AIRFLOW__API_AUTH__JWT_SECRET` must match the api-server's. Both are read from the `airflow-secret` Secret in [`k8s/airflow.yaml`](../k8s/airflow.yaml), but if you've edited the manifest and forgotten to wire the env var into the worker pod template (it's separate from the Deployments), you'll see this. Check:

```bash
kubectl get secret airflow-secret -o jsonpath='{.data.jwt-secret}' | base64 -d
kubectl logs <worker-pod-name>   # look for 'JWT' / 'unauthorized'
```

**Worker pod starts but immediately fails with `connection refused` to `airflow-api-server:8080`**

The worker pod template doesn't have `AIRFLOW__CORE__EXECUTION_API_SERVER_URL` set, or it points at the wrong Service name. Should be `http://airflow-api-server:8080/execution/` — note the trailing `/execution/`, not just the host.

**Scheduler logs say `Forbidden: pods is forbidden: User "system:serviceaccount:default:airflow" cannot create resource "pods"`**

RBAC missing. The Role + RoleBinding in [`k8s/airflow.yaml`](../k8s/airflow.yaml) grant `pods`, `pods/log`, `pods/exec`, and `events` to the `airflow` ServiceAccount. If you've narrowed the manifest, restore those rules.

**DAG appears in `/var/lib/lattik/airflow-dags/` but not in the UI**

Tail the dag-processor logs — it's the only component that writes to the `serialized_dag` table:

```bash
kubectl logs -l app=airflow-dag-processor --tail=100 -f
```

Look for `Errors found in DAG file` or `Failed to import` lines. A common gotcha is that `BashOperator`/`PythonOperator` imports moved between Airflow 2 and 3 — old DAG files copied from 2.x docs may need import fixes.

**`kubectl logs` for a worker pod returns nothing because the pod is gone**

`AIRFLOW__KUBERNETES_EXECUTOR__DELETE_WORKER_PODS=True` deletes worker pods on success (we keep them on failure for debugging — `DELETE_WORKER_PODS_ON_FAILURE=False`). For successful runs, look at the task logs in the UI instead — they're persisted to the hostPath log dir at `/var/lib/lattik/airflow-logs/dag_id=.../`, so they survive pod deletion.

**Memory pressure: kind node OOMs or Airflow pods evict**

Airflow 3 has more processes than 2.x — api-server + scheduler + dag-processor each request ~256–512Mi, plus 256–512Mi per concurrent worker pod. If you're also running trino (which alone wants ~1Gi), the kind node's memory budget gets tight. Bump Docker Desktop's memory to at least 8 GB. Cheap wins if you can't: drop replicas, lower the resource requests in [`k8s/airflow.yaml`](../k8s/airflow.yaml), or `pnpm trino:stop` when you're not using the data lake.

## See also

- [`k8s/airflow.yaml`](../k8s/airflow.yaml) — the manifest
- [`k8s/kind-config.yaml`](../k8s/kind-config.yaml) — port mapping (`30888` → host `8088`) and hostPath mounts for `airflow-dags` / `airflow-logs`
- [`airflow/dags/example_dag.py`](../airflow/dags/example_dag.py) — smoke-test DAG
- [`docs/local-data-lake.md`](local-data-lake.md) — Trino + Iceberg + MinIO, the obvious thing Airflow tasks will eventually want to talk to
- [Airflow 3 release notes](https://airflow.apache.org/docs/apache-airflow/stable/release_notes.html) — schema changes and breaking config keys
- [Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html) — official 2→3 guide
- [SimpleAuthManager docs](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/auth-manager/simple/index.html) — the auth manager we're using and its config keys
- [`projects/testenv`](../../testenv) — sibling repo running the same Airflow major via the official Helm chart, useful as a cross-reference when our handcrafted manifest drifts from upstream defaults
