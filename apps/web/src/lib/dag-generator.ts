/**
 * Generates Airflow DAG YAML specs from merged definitions and uploads them
 * to S3 (MinIO).  The Python DAG renderer in Airflow reads these YAML files
 * and dynamically creates DAG objects.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { toYaml } from "./yaml";
import { putObject, listObjects, deleteObject } from "./s3-client";

const S3_BUCKET = process.env.S3_DAG_BUCKET ?? "warehouse";
const S3_DAG_PREFIX = process.env.S3_DAG_PREFIX ?? "airflow-dags/";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskSpec {
  task_id: string;
  operator: "wait" | "spark";
  config: Record<string, string>;
  dependencies: string[];
}

interface DagSpec {
  dag_id: string;
  description: string;
  schedule: string | null;
  tags: string[];
  default_args: {
    owner: string;
    retries: number;
    retry_delay_minutes: number;
  };
  tasks: TaskSpec[];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function dagSpecForLattikTable(
  tableName: string,
  tableSpec: Record<string, unknown>,
): DagSpec {
  const tasks: TaskSpec[] = [];

  // Wait tasks — one per unique source table across column families
  const columnFamilies =
    (tableSpec.column_families as Array<{ source: string; name: string }>) ?? [];
  const sourceTables = [...new Set(columnFamilies.map((f) => f.source))];

  for (const sourceTable of sourceTables) {
    tasks.push({
      task_id: `wait__${sourceTable.replace(".", "_")}`,
      operator: "wait",
      config: { table: sourceTable },
      dependencies: [],
    });
  }

  // Build task — depends on all wait tasks
  tasks.push({
    task_id: `build__${tableName}`,
    operator: "spark",
    config: {
      job_type: "lattik_table",
      job_name: tableName,
      spec_json: JSON.stringify(tableSpec),
    },
    dependencies: tasks
      .filter((t) => t.operator === "wait")
      .map((t) => t.task_id),
  });

  return {
    dag_id: `lattik__${tableName}`,
    description:
      (tableSpec.description as string) ?? `Build ${tableName} lattik table`,
    schedule: null,
    tags: ["lattik", "lattik_table"],
    default_args: {
      owner: "lattik",
      retries: 2,
      retry_delay_minutes: 5,
    },
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Backfill DAG generator
// ---------------------------------------------------------------------------

type ColumnStrategy = "lifetime_window" | "prepend_list" | "bitmap_activity";

interface FamilySpec {
  name: string;
  source: string;
  columns: Array<{ name: string; strategy: ColumnStrategy }>;
}

/**
 * Determine the backfill strategy for a family based on its column strategies.
 * - "sequential": has lifetime_window columns → must cascade in ds order
 * - "parallel": only bitmap_activity / prepend_list → deltas are independent per ds
 */
function backfillStrategy(family: FamilySpec): "sequential" | "parallel" {
  return family.columns.some((c) => c.strategy === "lifetime_window")
    ? "sequential"
    : "parallel";
}

/**
 * Generate a backfill DAG spec for a Lattik Table.
 *
 * The backfill DAG is parameterized by ds_start and ds_end (passed via Airflow
 * conf at trigger time). Each family gets its own task chain based on its
 * backfill strategy:
 *
 * - Sequential families: linear chain from ds_start to ds_end, then cascade to today
 * - Parallel families: fan-out delta tasks, then a sequential cumulative pass
 *
 * This function generates a TEMPLATE DAG with Jinja-parameterized task IDs.
 * At runtime, the DAG renderer expands the template based on the conf params.
 */
function backfillDagSpecForLattikTable(
  tableName: string,
  tableSpec: Record<string, unknown>,
): DagSpec {
  const tasks: TaskSpec[] = [];
  const columnFamilies = (tableSpec.column_families ?? []) as FamilySpec[];
  const backfillPlan = (tableSpec.backfill ?? {}) as {
    lookback?: string;
    parallelism?: number;
  };
  const parallelism = backfillPlan.parallelism ?? 1;
  const specJson = JSON.stringify(tableSpec);

  for (const family of columnFamilies) {
    const familyName = family.name || family.source.split(".").pop() || family.source;
    const strategy = backfillStrategy(family);

    if (strategy === "sequential") {
      // Sequential cascade: each ds depends on the previous ds.
      // The DAG renderer generates one task per ds in the range.
      // We represent this as a single "sequential_backfill" meta-task
      // that the Python DAG renderer expands into a chain.
      tasks.push({
        task_id: `backfill__${familyName}`,
        operator: "spark",
        config: {
          job_type: "lattik_table_backfill",
          job_name: tableName,
          family_name: familyName,
          strategy: "sequential",
          spec_json: specJson,
        },
        dependencies: [],
      });
    } else {
      // Parallel fan-out: delta computation is independent per ds.
      // The DAG renderer generates parallel tasks up to the parallelism limit,
      // followed by a sequential cumulative pass.
      tasks.push({
        task_id: `backfill_deltas__${familyName}`,
        operator: "spark",
        config: {
          job_type: "lattik_table_backfill_deltas",
          job_name: tableName,
          family_name: familyName,
          strategy: "parallel",
          parallelism: String(parallelism),
          spec_json: specJson,
        },
        dependencies: [],
      });

      // Cumulative pass depends on all deltas being computed
      tasks.push({
        task_id: `backfill_cumulative__${familyName}`,
        operator: "spark",
        config: {
          job_type: "lattik_table_backfill_cumulative",
          job_name: tableName,
          family_name: familyName,
          spec_json: specJson,
        },
        dependencies: [`backfill_deltas__${familyName}`],
      });
    }
  }

  // Final commit task depends on all family backfills
  const allFamilyTasks = tasks.map((t) => t.task_id);
  tasks.push({
    task_id: `backfill_commit__${tableName}`,
    operator: "spark",
    config: {
      job_type: "lattik_table_backfill_commit",
      job_name: tableName,
      spec_json: specJson,
    },
    dependencies: allFamilyTasks,
  });

  return {
    dag_id: `backfill__${tableName}`,
    description: `Backfill ${tableName} lattik table`,
    schedule: null, // triggered manually or via Airflow CLI
    tags: ["lattik", "lattik_table", "backfill"],
    default_args: {
      owner: "lattik",
      retries: 1,
      retry_delay_minutes: 10,
    },
    tasks,
  };
}

/**
 * Generate DAG YAML files from all merged lattik_table definitions and
 * upload them to S3.  Returns the list of S3 keys that were written.
 */
export async function generateDags(): Promise<string[]> {
  const db = getDb();

  const mergedDefs = await db
    .select()
    .from(schema.definitions)
    .where(eq(schema.definitions.status, "merged"));

  const lattikTables = mergedDefs.filter((d) => d.kind === "lattik_table");

  const writtenKeys: string[] = [];

  for (const table of lattikTables) {
    const spec = table.spec as Record<string, unknown>;
    const tableName = (spec.name as string) ?? table.name;

    // Forward-run DAG
    const dagSpec = dagSpecForLattikTable(tableName, spec);
    const header =
      `# DAG: ${dagSpec.dag_id}\n` +
      `# Generated by Lattik Studio from merged definition "${tableName}"\n\n`;
    const yamlContent = header + toYaml(dagSpec);
    const key = `${S3_DAG_PREFIX}${dagSpec.dag_id}.yaml`;
    await putObject(S3_BUCKET, key, yamlContent);
    writtenKeys.push(key);

    // Backfill DAG
    const backfillSpec = backfillDagSpecForLattikTable(tableName, spec);
    const backfillHeader =
      `# DAG: ${backfillSpec.dag_id}\n` +
      `# Backfill DAG generated by Lattik Studio for "${tableName}"\n\n`;
    const backfillYaml = backfillHeader + toYaml(backfillSpec);
    const backfillKey = `${S3_DAG_PREFIX}${backfillSpec.dag_id}.yaml`;
    await putObject(S3_BUCKET, backfillKey, backfillYaml);
    writtenKeys.push(backfillKey);
  }

  // Clean up S3 keys for DAGs whose definitions were removed
  const expectedKeys = new Set(writtenKeys);
  const existingKeys = await listObjects(S3_BUCKET, S3_DAG_PREFIX);
  for (const existing of existingKeys) {
    if (existing.endsWith(".yaml") && !expectedKeys.has(existing)) {
      await deleteObject(S3_BUCKET, existing);
    }
  }

  return writtenKeys;
}
