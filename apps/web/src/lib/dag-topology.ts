import type { DagDef, TaskDef } from "@/schemas/dag";

/**
 * Topological sort of a DAG's tasks. Throws on a cycle or on a `dependsOn`
 * entry that names a task absent from the DAG. Returns tasks in an order
 * such that every task appears after each of its `dependsOn` entries.
 */
export function topoSort(tasks: TaskDef[]): TaskDef[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    indegree.set(t.id, (t.dependsOn ?? []).length);
    for (const dep of t.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`task '${t.id}' depends on unknown task '${dep}'`);
      }
      const list = adj.get(dep) ?? [];
      list.push(t.id);
      adj.set(dep, list);
    }
  }

  const ready: string[] = [];
  for (const [id, n] of indegree) if (n === 0) ready.push(id);
  const out: TaskDef[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const child of adj.get(id) ?? []) {
      const n = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, n);
      if (n === 0) ready.push(child);
    }
  }
  if (out.length !== tasks.length) {
    throw new Error("DAG has a cycle");
  }
  return out;
}

/** Resolve `task.timeout ?? parsed.defaults.timeout` into a single shape. */
export function effectiveTaskConfig(
  parsed: DagDef,
  task: TaskDef
): { timeout: string } {
  return { timeout: task.timeout ?? parsed.defaults.timeout };
}

/**
 * Parse a duration string like "30s" / "5m" / "2h" into milliseconds.
 * Mirrors the regex on the Zod schema; throws on malformed input so any
 * desync between schema and parser surfaces at task-launch time.
 */
export function parseDurationMs(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/i.exec(s);
  if (!m) throw new Error(`invalid duration '${s}'`);
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "ms":
      return n;
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      throw new Error(`invalid duration unit in '${s}'`);
  }
}
