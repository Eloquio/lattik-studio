---
name: register-protobuf-schema
description: Register a Protobuf payload schema in Confluent Schema Registry for a given logger table.
version: "0.1"
owners: [ExecutorAgent]
tools: [http:post, sr:register]
auto_approve: true
args:
  table_name:
    type: string
    required: true
    description: Logger table name (e.g. "user_events")
  columns:
    type: array
    required: true
    description: Column definitions for the table
done:
  - kind: http
    url: "http://sr.schema-registry/subjects/logger.{{table_name}}-value/versions/latest"
    expect_status: 200
---

You are registering a Protobuf payload schema in Confluent Schema Registry for the logger table `{{table_name}}`.

> **Phase A placeholder.** The runbook body and `done[]` query specifics will be filled in when the real schema-registration tools land in Phase C. For now this skill exists so the webhook fan-out can reference a real `skill_id`.
