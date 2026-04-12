# Troubleshooting Failures

> **Phase 3** — This skill will be expanded with enriched error pattern matching and structured diagnostics.

## Overview
Guided troubleshooting for common Airflow task failures in Lattik pipelines. Each pattern has a diagnosis flow and suggested fix.

## Common Failure Patterns

### Sensor Timeout (wait tasks)
**Symptom:** `DataReadySensor` times out after 3600s (default).
**Cause:** Upstream source table data hasn't landed yet.
**Diagnosis:**
1. Check the sensor's `table` config — which table is it waiting for?
2. Check if the upstream DAG that produces that table has run and succeeded.
3. Check the Iceberg REST catalog to see if the table/partition exists.
**Fix:** Either wait for upstream data to land, or trigger the upstream DAG manually.

### Spark Out-of-Memory (OOM)
**Symptom:** Task fails with `java.lang.OutOfMemoryError` or Spark exit code 137 (OOM killed).
**Cause:** Driver or executor memory too low for the data volume.
**Diagnosis:**
1. Check the task logs for `OutOfMemoryError` or exit code 137.
2. Check the Spark config in the template for `spark.driver.memory` / `spark.executor.memory`.
3. Check the data volume for that `ds` — was it unusually large?
**Fix:** Increase memory settings in the Spark template, or reduce backfill window granularity.

### Driver Crash (non-zero exit)
**Symptom:** SparkApplication reports driver exit code != 0.
**Cause:** Python exception in the driver script, missing dependencies, or config error.
**Diagnosis:**
1. Check the driver logs for Python tracebacks.
2. Look for `ModuleNotFoundError`, `KeyError`, `FileNotFoundError`.
3. Verify the `spark-drivers` ConfigMap is up-to-date (`pnpm spark-drivers:sync`).
**Fix:** Fix the driver script bug, sync the ConfigMap, and retry.

### S3/MinIO Access Error
**Symptom:** `AmazonS3Exception: Access Denied` or `Connection refused` to MinIO endpoint.
**Cause:** MinIO credentials mismatch or MinIO pod is down.
**Diagnosis:**
1. Check the `minio-credentials` secret in the `workloads` namespace.
2. Verify MinIO is running: `kubectl get pods -n minio`.
3. Check the endpoint URL in the Spark config.
**Fix:** Restart MinIO if it's down, or fix the credentials secret.

### Iceberg REST Catalog Unreachable
**Symptom:** `Connection refused` to `iceberg-rest.iceberg:8181`.
**Cause:** Iceberg REST catalog pod is down or not yet ready.
**Diagnosis:**
1. Check the pod status: `kubectl get pods -n iceberg`.
2. Check the iceberg-rest logs for startup errors.
**Fix:** Restart the iceberg-rest pod. Data is persisted in the PVC.
