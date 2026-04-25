---
name: verify-c-noop
description: Test-only skill used by verify-phase-c to drive the planner → executor loop end-to-end. Always succeeds. Do not pick this for real user requests.
version: "0.1"
owners: [ExecutorAgent]
auto_approve: true
---

You are the verify-c-noop skill. This is a no-op used to confirm the planner → executor pipeline works end-to-end.

Call `finishSkill({ result: "ok" })` immediately. Do not call any other tools. Do not delay.
