"""
Lattik Table batch driver — builds one ds of a Lattik Table.

Runs as a SparkApplication via the Spark Operator. Each invocation processes
one ds (or ds+hour) for all column families in the table, writes bucketed
load files to S3, and commits via the Lattik Studio API.

Usage (via SparkApplication template):
  driver.py --job-type=lattik_table --job-name=user_stats --ds=2026-04-09
            [--hour=12] [--api-url=https://lattik-studio.dev]
"""

import argparse
import json
import math
import os
import sys
import uuid

import requests
from pyspark.sql import SparkSession, DataFrame
from pyspark.sql import functions as F
from pyspark.sql.types import StructType


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LATTIK_API = os.environ.get("LATTIK_API_URL", "https://lattik-studio.dev/api/lattik")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://minio.minio.svc.cluster.local:9000")
S3_BUCKET = os.environ.get("S3_BUCKET", "warehouse")
TARGET_BUCKET_SIZE = int(os.environ.get("TARGET_BUCKET_SIZE", str(128 * 1024 * 1024)))
FORMAT_ID = os.environ.get("FORMAT_ID", "parquet")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def next_power_of_2(n: int) -> int:
    if n <= 1:
        return 1
    p = 1
    while p < n:
        p *= 2
    return min(p, 4096)


def estimate_size(df: DataFrame) -> int:
    """Rough size estimate based on row count and schema width."""
    # Use Spark's sizeEstimator if available; otherwise heuristic
    count = df.count()
    avg_row_bytes = sum(8 if f.dataType.simpleString() in ("bigint", "double", "long")
                        else 32  # rough estimate for strings, binary, etc.
                        for f in df.schema.fields)
    return count * avg_row_bytes


def determine_bucket_levels(df: DataFrame, pk_columns: list[str]) -> list[int]:
    """Auto-determine per-level bucket counts for hierarchical bucketing."""
    total_size = estimate_size(df)
    total_buckets = next_power_of_2(total_size // TARGET_BUCKET_SIZE)
    total_buckets = max(1, min(total_buckets, 4096))

    if len(pk_columns) == 1:
        return [total_buckets]

    # Distribute across levels using sqrt heuristic
    level_1 = next_power_of_2(int(total_buckets ** 0.5))
    level_2 = max(1, total_buckets // level_1)
    if len(pk_columns) == 2:
        return [level_1, level_2]

    level_2_sub = next_power_of_2(int(level_2 ** 0.5))
    level_3 = max(1, level_2 // level_2_sub)
    return [level_1, level_2_sub, level_3]


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def aggregate_family(spark: SparkSession, family: dict, ds: str,
                     hour: int | None, prev_load_path: str | None) -> DataFrame:
    """
    Read source table, apply key_mapping, aggregate per column strategy.
    Returns a DataFrame with PK columns + cumulative columns + delta columns.
    """
    source = family["source"]
    key_mapping = family.get("key_mapping", {})
    columns = family["columns"]

    # Read source events for this ds
    source_df = spark.read.table(source)
    if hour is not None:
        source_df = source_df.filter(
            (F.col("ds") == ds) & (F.col("hour") == hour)
        )
    else:
        source_df = source_df.filter(F.col("ds") == ds)

    # Apply key_mapping: rename source columns to PK column names
    for pk_col, source_col in key_mapping.items():
        if pk_col != source_col:
            source_df = source_df.withColumnRenamed(source_col, pk_col)

    pk_columns = list(key_mapping.keys())

    # Build aggregation expressions per column based on strategy
    agg_exprs = []
    for col in columns:
        strategy = col["strategy"]
        col_name = col["name"]
        delta_name = f"{col_name}__delta"

        if strategy == "lifetime_window":
            agg_expr = col["agg"]
            # Delta: aggregate this period only
            agg_exprs.append(F.expr(agg_expr).alias(delta_name))

        elif strategy == "prepend_list":
            expr = col["expr"]
            # Delta: collect values from this period
            agg_exprs.append(
                F.collect_list(F.expr(expr)).alias(delta_name)
            )

        elif strategy == "bitmap_activity":
            # Delta: just a flag that activity occurred
            agg_exprs.append(F.lit(1).alias(delta_name))

    # Group by PK, compute deltas
    delta_df = source_df.groupBy(*pk_columns).agg(*agg_exprs)

    # Merge delta with previous ds's cumulative to produce new cumulative columns.
    # If prev_load_path is None, delta IS the cumulative (first load).
    if prev_load_path is not None:
        try:
            prev_df = spark.read.parquet(prev_load_path)
            # FULL OUTER JOIN on PK
            joined = delta_df.alias("d").join(prev_df.alias("c"), on=pk_columns, how="full_outer")
            for col in columns:
                col_name = col["name"]
                delta_name = f"{col_name}__delta"
                strategy = col["strategy"]

                if strategy == "lifetime_window":
                    agg = col.get("agg", "").lower()
                    if "count" in agg or "sum" in agg:
                        joined = joined.withColumn(
                            col_name,
                            F.coalesce(F.col(f"c.{col_name}"), F.lit(0)) +
                            F.coalesce(F.col(f"d.{delta_name}"), F.lit(0))
                        )
                    elif "max" in agg:
                        joined = joined.withColumn(
                            col_name,
                            F.greatest(F.coalesce(F.col(f"c.{col_name}"), F.col(f"d.{delta_name}")),
                                       F.coalesce(F.col(f"d.{delta_name}"), F.col(f"c.{col_name}")))
                        )
                    else:
                        joined = joined.withColumn(
                            col_name,
                            F.coalesce(F.col(f"d.{delta_name}"), F.col(f"c.{col_name}"))
                        )
                elif strategy == "prepend_list":
                    max_length = col.get("max_length", 10)
                    joined = joined.withColumn(
                        col_name,
                        F.slice(F.concat(
                            F.coalesce(F.col(f"d.{delta_name}"), F.array()),
                            F.coalesce(F.col(f"c.{col_name}"), F.array())
                        ), 1, max_length)
                    )
                elif strategy == "bitmap_activity":
                    joined = joined.withColumn(
                        col_name,
                        F.when(F.col(f"d.{delta_name}").isNotNull() |
                               F.col(f"c.{col_name}").isNotNull(), F.lit(1)).otherwise(F.lit(0))
                    )

            # Resolve ambiguous PK columns
            for pk in pk_columns:
                joined = joined.withColumn(pk, F.coalesce(F.col(f"d.{pk}"), F.col(f"c.{pk}")))

            select_cols = pk_columns + [col["name"] for col in columns] + [f"{col['name']}__delta" for col in columns]
            return joined.select(*select_cols)

        except Exception as e:
            print(f"[lattik] Warning: could not read previous load at {prev_load_path}: {e}")
            print("[lattik] Falling back to delta-only (first load behavior)")

    # No previous cumulative — delta IS the cumulative
    for col in columns:
        col_name = col["name"]
        delta_name = f"{col_name}__delta"
        delta_df = delta_df.withColumn(col_name, F.col(delta_name))

    return delta_df


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

def write_load(df: DataFrame, table_path: str, pk_columns: list[str],
               column_names: list[str], ds: str, hour: int | None,
               mode: str = "forward") -> tuple[str, list[int], int]:
    """
    Write a DataFrame as a new immutable load to S3.
    Returns (load_id, bucket_levels, total_buckets).
    """
    load_id = str(uuid.uuid4())
    load_path = f"{table_path}/loads/{load_id}"

    # Auto-determine hierarchical bucket levels
    bucket_levels = determine_bucket_levels(df, pk_columns)
    total_buckets = 1
    for lvl in bucket_levels:
        total_buckets *= lvl

    # Compute hierarchical bucket ID per row
    df_bucketed = df
    sub_count = 1
    for i in reversed(range(len(pk_columns))):
        col = pk_columns[i]
        lvl = bucket_levels[i]
        level_col = f"_bucket_l{i}"
        df_bucketed = df_bucketed.withColumn(
            level_col, F.abs(F.xxhash64(F.col(col))) % F.lit(lvl)
        )
        if i == len(pk_columns) - 1:
            df_bucketed = df_bucketed.withColumn("_bucket", F.col(level_col))
        else:
            df_bucketed = df_bucketed.withColumn(
                "_bucket",
                F.col(level_col) * F.lit(sub_count) + F.col("_bucket")
            )
        sub_count *= lvl

    # Repartition by bucket, sort by PK within each bucket (Parquet needs sorted data)
    df_bucketed = df_bucketed.repartition(total_buckets, "_bucket")
    if FORMAT_ID == "parquet":
        df_bucketed = df_bucketed.sortWithinPartitions(*pk_columns)

    # Select only data columns + bucket for partitioned write
    # Include both cumulative and delta columns
    all_columns = pk_columns.copy()
    for name in column_names:
        all_columns.append(name)           # cumulative
        all_columns.append(f"{name}__delta")  # delta

    df_out = df_bucketed.select(*all_columns, "_bucket")

    # Write load.json
    load_meta = {
        "load_id": load_id,
        "timestamp": str(F.current_timestamp()),  # will be replaced with actual timestamp
        "ds": ds,
        "hour": hour,
        "mode": mode,
        "format": FORMAT_ID,
        "bucket_levels": bucket_levels,
        "bucket_count": total_buckets,
        "sorted": FORMAT_ID == "parquet",
        "has_pk_index": FORMAT_ID in ("vortex", "lance"),
        "columns": column_names,
    }

    # Write load.json via Spark (simpler than calling S3 API from driver)
    spark = df.sparkSession
    load_json_rdd = spark.sparkContext.parallelize([json.dumps(load_meta, indent=2)])
    load_json_rdd.saveAsTextFile(f"s3a://{S3_BUCKET}/{load_path}/load.json")

    # Write data partitioned by bucket
    (
        df_out
        .write
        .mode("overwrite")
        .partitionBy("_bucket")
        .parquet(f"s3a://{S3_BUCKET}/{load_path}/data")
    )

    print(f"[lattik] Wrote load {load_id}: {total_buckets} buckets, "
          f"levels={bucket_levels}, format={FORMAT_ID}")

    return load_id, bucket_levels, total_buckets


# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------

def commit_via_api(table_name: str, base_version: int, load_id: str,
                   columns: dict[str, str], ds: str, hour: int | None) -> int:
    """Commit via the Lattik Studio API. Retries on OCC conflict."""
    while True:
        resp = requests.post(f"{LATTIK_API}/commit", json={
            "table_name": table_name,
            "base_version": base_version,
            "load_id": load_id,
            "columns": columns,
            "ds": ds,
            "hour": hour,
        })
        result = resp.json()

        if result["status"] == "committed":
            print(f"[lattik] Committed version {result['version']} for {table_name}")
            return result["version"]

        if result["status"] == "conflict":
            print(f"[lattik] OCC conflict, rebasing from v{result['base_version']}")
            base_version = result["base_version"]
            continue

        raise RuntimeError(f"Commit failed: {result}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Lattik Table batch driver")
    parser.add_argument("--job-type", required=True)
    parser.add_argument("--job-name", required=True, help="Table name")
    parser.add_argument("--ds", required=True, help="Logical execution date (YYYY-MM-DD)")
    parser.add_argument("--hour", type=int, default=None, help="Hour (0-23) for hourly cadence")
    parser.add_argument("--api-url", default=None, help="Lattik Studio API URL")
    parser.add_argument("--spec-json", default=None, help="Table spec as JSON string")
    args = parser.parse_args()

    if args.api_url:
        global LATTIK_API
        LATTIK_API = args.api_url

    if args.job_type != "lattik_table":
        print(f"[lattik] Unknown job type: {args.job_type}", file=sys.stderr)
        sys.exit(1)

    table_name = args.job_name

    # Build Spark session
    spark = (
        SparkSession.builder
        .appName(f"lattik_table__{table_name}__{args.ds}")
        .getOrCreate()
    )

    try:
        # Read table spec — either from CLI arg or from the API
        if args.spec_json:
            spec = json.loads(args.spec_json)
        else:
            # TODO: fetch spec from the API (GET /api/lattik/spec?table=<name>)
            print(f"[lattik] No --spec-json provided, cannot proceed", file=sys.stderr)
            sys.exit(1)

        # Read latest commit version from the API
        resp = requests.get(f"{LATTIK_API}/commit",
                           params={"table": table_name, "mode": "latest"})
        if resp.status_code == 404:
            base_version = 0
        else:
            base_version = resp.json().get("manifest_version", 0)

        table_path = f"lattik/{table_name}"
        pk_columns = [pk["column"] for pk in spec["primary_key"]]

        # Process each family
        column_overrides: dict[str, str] = {}  # column_name → load_id

        for family in spec["column_families"]:
            family_name = family.get("name") or family["source"].split(".")[-1]
            column_names = [col["name"] for col in family["columns"]]

            print(f"[lattik] Processing family '{family_name}': "
                  f"source={family['source']}, columns={column_names}")

            # Aggregate source data
            family_df = aggregate_family(spark, family, args.ds, args.hour, None)

            # Write load to S3
            load_id, bucket_levels, total_buckets = write_load(
                family_df, table_path, pk_columns, column_names,
                args.ds, args.hour,
            )

            for col_name in column_names:
                column_overrides[col_name] = load_id

        # Commit via API
        primary_load_id = list(set(column_overrides.values()))[0]
        version = commit_via_api(
            table_name, base_version, primary_load_id,
            column_overrides, args.ds, args.hour,
        )

        print(f"[lattik] Done: {table_name} ds={args.ds} → version {version}")

    finally:
        spark.stop()


if __name__ == "__main__":
    main()
