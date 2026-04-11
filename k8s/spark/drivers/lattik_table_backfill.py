"""
Lattik Table backfill driver — reprocesses a date range and cascades.

Reads source events for each ds in [ds_start, ds_end], computes new deltas,
merges with previous cumulative values per column strategy, writes new loads,
and cascades cumulative recompute through ds_end+1 to today.

Usage:
  spark-submit lattik_table_backfill.py \
    --job-name=user_stats \
    --ds-start=2026-04-01 --ds-end=2026-04-05 \
    --spec-json='{"name":"user_stats",...}' \
    [--api-url=https://lattik-studio.dev]

The backfill processes families based on their column strategies:
- Sequential (lifetime_window): must process ds values in order
- Parallel (bitmap_activity, prepend_list): deltas are independent per ds
"""

import argparse
import json
from datetime import datetime, timedelta

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from lattik_driver_utils import (
    commit_via_api,
    get_latest_version,
    merge_cumulative,
    set_api_url,
    write_load,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def date_range(ds_start: str, ds_end: str) -> list[str]:
    """Generate a list of YYYY-MM-DD strings from ds_start to ds_end (inclusive)."""
    start = datetime.strptime(ds_start, "%Y-%m-%d")
    end = datetime.strptime(ds_end, "%Y-%m-%d")
    dates = []
    d = start
    while d <= end:
        dates.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return dates


def today_str() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def family_needs_cascade(family: dict) -> bool:
    """Does this family have lifetime_window columns that depend on previous ds?"""
    return any(col["strategy"] == "lifetime_window" for col in family["columns"])


def compute_delta(
    spark: SparkSession, family: dict, ds: str, hour: int | None
) -> DataFrame:
    """Read source events for one ds and compute the delta per column strategy."""
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

    if not agg_exprs:
        return spark.createDataFrame([], source_df.schema)

    return source_df.groupBy(*pk_columns).agg(*agg_exprs)


# ---------------------------------------------------------------------------
# Backfill logic
# ---------------------------------------------------------------------------

def backfill_family(
    spark: SparkSession,
    table_name: str,
    table_path: str,
    family: dict,
    pk_columns: list[str],
    ds_list: list[str],
    hour: int | None,
    cascade_to_today: bool = True,
):
    """
    Backfill one family for a range of ds values.

    For families with lifetime_window columns (needs_cascade=True):
    1. For each ds in ds_list: read source → compute delta → merge with prev cumulative
    2. If cascade_to_today: for each ds from ds_list[-1]+1 to today, recompute
       cumulative using existing stored deltas

    For families without cascade (bitmap_activity, prepend_list only):
    1. For each ds in ds_list: read source → compute delta (independent)
    2. Sequential cumulative pass using the freshly computed deltas
    """
    family_name = family.get("name") or family["source"].split(".")[-1]
    columns = family["columns"]
    column_names = [col["name"] for col in columns]
    needs_cascade = family_needs_cascade(family)

    print(
        f"[backfill] Family '{family_name}': {len(ds_list)} ds values, "
        f"cascade={'yes' if needs_cascade else 'no'}"
    )

    prev_cumulative: DataFrame | None = None
    base_version = get_latest_version(table_name)

    # Phase 1: process each ds in the backfill range
    for ds in ds_list:
        print(f"[backfill] Processing ds={ds} for family '{family_name}'...")

        delta_df = compute_delta(spark, family, ds, hour)
        if delta_df.isEmpty():
            print(f"[backfill] No source data for ds={ds}, skipping")
            continue

        merged_df = merge_cumulative(prev_cumulative, delta_df, columns, pk_columns)

        load_id, _, _ = write_load(
            merged_df,
            table_path,
            pk_columns,
            column_names,
            ds,
            hour,
            mode="backfill",
        )

        column_overrides = {name: load_id for name in column_names}
        base_version = commit_via_api(
            table_name,
            base_version,
            load_id,
            column_overrides,
            ds,
            hour,
            log_prefix="backfill",
        )

        if needs_cascade:
            prev_cumulative = merged_df

    # Phase 2: cascade (recompute downstream ds values using existing deltas)
    if needs_cascade and cascade_to_today:
        last_backfill_ds = ds_list[-1]
        cascade_start = (
            datetime.strptime(last_backfill_ds, "%Y-%m-%d") + timedelta(days=1)
        ).strftime("%Y-%m-%d")
        cascade_end = today_str()

        if cascade_start <= cascade_end:
            cascade_dates = date_range(cascade_start, cascade_end)
            print(
                f"[backfill] Cascading {len(cascade_dates)} ds values "
                f"from {cascade_start} to {cascade_end}"
            )

            for ds in cascade_dates:
                # TODO: Read existing delta from the load's Parquet file
                delta_df = compute_delta(spark, family, ds, hour)

                if delta_df.isEmpty():
                    print(f"[backfill] No data for cascade ds={ds}, skipping")
                    continue

                merged_df = merge_cumulative(
                    prev_cumulative, delta_df, columns, pk_columns
                )

                load_id, _, _ = write_load(
                    merged_df,
                    table_path,
                    pk_columns,
                    column_names,
                    ds,
                    hour,
                    mode="backfill",
                )

                column_overrides = {name: load_id for name in column_names}
                base_version = commit_via_api(
                    table_name,
                    base_version,
                    load_id,
                    column_overrides,
                    ds,
                    hour,
                    log_prefix="backfill",
                )

                prev_cumulative = merged_df

    print(f"[backfill] Family '{family_name}' complete")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Lattik Table backfill driver")
    parser.add_argument("--job-name", required=True, help="Table name")
    parser.add_argument("--ds-start", required=True, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--ds-end", required=True, help="End date (YYYY-MM-DD)")
    parser.add_argument("--hour", type=int, default=None)
    parser.add_argument("--api-url", default=None)
    parser.add_argument("--spec-json", required=True, help="Table spec as JSON")
    parser.add_argument(
        "--no-cascade", action="store_true", help="Skip cascading to today"
    )
    args = parser.parse_args()

    if args.api_url:
        set_api_url(args.api_url)

    table_name = args.job_name
    spec = json.loads(args.spec_json)
    ds_list = date_range(args.ds_start, args.ds_end)

    print(f"[backfill] Table: {table_name}")
    print(
        f"[backfill] Date range: {args.ds_start} to {args.ds_end} "
        f"({len(ds_list)} days)"
    )
    print(f"[backfill] Cascade: {'no' if args.no_cascade else 'yes'}")

    spark = (
        SparkSession.builder
        .appName(
            f"lattik_backfill__{table_name}__{args.ds_start}_{args.ds_end}"
        )
        .getOrCreate()
    )

    try:
        table_path = f"lattik/{table_name}"
        pk_columns = [pk["column"] for pk in spec["primary_key"]]

        for family in spec["column_families"]:
            backfill_family(
                spark,
                table_name,
                table_path,
                family,
                pk_columns,
                ds_list,
                args.hour,
                cascade_to_today=not args.no_cascade,
            )

        print(f"\n{'=' * 60}")
        print(f"[backfill] BACKFILL COMPLETE: {table_name}")
        print(f"[backfill] Range: {args.ds_start} to {args.ds_end}")
        print(f"{'=' * 60}")

    finally:
        spark.stop()


if __name__ == "__main__":
    main()
