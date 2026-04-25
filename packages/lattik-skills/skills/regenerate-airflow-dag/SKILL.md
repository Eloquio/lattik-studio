---
name: regenerate-airflow-dag
description: Regenerate Airflow DAG YAML specs and upload them to S3 so the Airflow dag-renderer picks up changes.
version: "0.1"
owners: [ExecutorAgent]
tools: [s3:write]
auto_approve: true
args:
  table_name:
    type: string
    required: true
    description: Logger table name whose DAGs should be regenerated
done:
  - kind: s3_object_exists
    bucket: warehouse
    key: "airflow-dags/{{table_name}}.yaml"
---

You are regenerating the Airflow DAG YAML for logger table `{{table_name}}` and uploading it to S3.

> **Phase A placeholder.** The runbook body and DAG-generation logic will be filled in when the real DAG-emit tools land in Phase C. For now this skill exists so the webhook fan-out can reference a real `skill_id`.
