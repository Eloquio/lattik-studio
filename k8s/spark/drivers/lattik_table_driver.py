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
import sys

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

import lattik_driver_utils as utils
from lattik_driver_utils import (
    commit_via_api,
    get_latest_version,
    merge_cumulative,
    set_api_url,
    write_load,
)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def aggregate_family(
    spark: SparkSession,
    family: dict,
    ds: str,
    hour: int | None,
    prev_load_path: str | None,
) -> DataFrame:
    """
    Read source table, apply key_mapping, aggregate per column strategy.

    Returns a DataFrame with PK columns + cumulative columns + delta columns.
    If `prev_load_path` is provided and readable, merges with the previous
    cumulative load via `merge_cumulative`.
    """
    source = family["source"]
    key_mapping = family.get("key_mapping", {})
    columns = family["columns"]

    source_df = spark.read.table(source)
    if hour is not None:
        source_df = source_df.filter(
            (F.col("ds") == ds) & (F.col("hour") == hour)
        )
    else:
        source_df = source_df.filter(F.col("ds") == ds)

    for pk_col, source_col in key_mapping.items():
        if pk_col != source_col:
            source_df = source_df.withColumnRenamed(source_col, pk_col)

    pk_columns = list(key_mapping.keys())

    agg_exprs = []
    for col in columns:
        strategy = col["strategy"]
        col_name = col["name"]
        delta_name = f"{col_name}__delta"

        if strategy == "lifetime_window":
            agg_exprs.append(F.expr(col["agg"]).alias(delta_name))
        elif strategy == "prepend_list":
            agg_exprs.append(
                F.collect_list(F.expr(col["expr"])).alias(delta_name)
            )
        elif strategy == "bitmap_activity":
            agg_exprs.append(F.lit(1).alias(delta_name))

    delta_df = source_df.groupBy(*pk_columns).agg(*agg_exprs)

    prev_df: DataFrame | None = None
    if prev_load_path is not None:
        try:
            prev_df = spark.read.parquet(prev_load_path)
        except Exception as e:
            print(
                f"[lattik] Warning: could not read previous load at "
                f"{prev_load_path}: {e}"
            )
            print("[lattik] Falling back to delta-only (first load behavior)")
            prev_df = None

    return merge_cumulative(prev_df, delta_df, columns, pk_columns)


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
        set_api_url(args.api_url)

    if args.job_type != "lattik_table":
        print(f"[lattik] Unknown job type: {args.job_type}", file=sys.stderr)
        sys.exit(1)

    table_name = args.job_name

    spark = (
        SparkSession.builder
        .appName(f"lattik_table__{table_name}__{args.ds}")
        .getOrCreate()
    )

    try:
        if args.spec_json:
            spec = json.loads(args.spec_json)
        else:
            print(
                "[lattik] No --spec-json provided, cannot proceed",
                file=sys.stderr,
            )
            sys.exit(1)

        base_version = get_latest_version(table_name)
        table_path = f"lattik/{table_name}"
        pk_columns = [pk["column"] for pk in spec["primary_key"]]

        column_overrides: dict[str, str] = {}

        for family in spec["column_families"]:
            family_name = family.get("name") or family["source"].split(".")[-1]
            column_names = [col["name"] for col in family["columns"]]

            print(
                f"[lattik] Processing family '{family_name}': "
                f"source={family['source']}, columns={column_names}"
            )

            family_df = aggregate_family(spark, family, args.ds, args.hour, None)

            load_id, _, _ = write_load(
                family_df,
                table_path,
                pk_columns,
                column_names,
                args.ds,
                args.hour,
                mode="forward",
            )

            for col_name in column_names:
                column_overrides[col_name] = load_id

        primary_load_id = next(iter(column_overrides.values()))
        version = commit_via_api(
            table_name,
            base_version,
            primary_load_id,
            column_overrides,
            args.ds,
            args.hour,
            log_prefix="lattik",
        )

        print(
            f"[lattik] Done: {table_name} ds={args.ds} → version {version}"
        )

    finally:
        spark.stop()


if __name__ == "__main__":
    main()
