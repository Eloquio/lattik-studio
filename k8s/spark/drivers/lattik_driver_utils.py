"""
Shared utilities for the Lattik Table PySpark batch drivers.

Both the forward driver (`lattik_table_driver.py`) and the backfill driver
(`lattik_table_backfill.py`) import from this module. Keep read-path code
(e.g. future scan utilities) in a sibling module — this one is strictly
about the write path: bucketing, cumulative merging, load IO, and commits.
"""

from __future__ import annotations

import json
import math
import os
import uuid
from datetime import datetime
from typing import Callable, Optional

import requests
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LATTIK_API = os.environ.get("LATTIK_API_URL", "https://lattik-studio.dev/api/lattik")
LATTIK_API_TOKEN = os.environ.get("LATTIK_API_TOKEN")
S3_BUCKET = os.environ.get("S3_BUCKET", "warehouse")
TARGET_BUCKET_SIZE = int(os.environ.get("TARGET_BUCKET_SIZE", str(128 * 1024 * 1024)))
FORMAT_ID = os.environ.get("FORMAT_ID", "parquet")
MAX_BUCKETS = 4096


def set_api_url(url: str) -> None:
    """Override the Lattik Studio API base URL (used by `--api-url`)."""
    global LATTIK_API
    LATTIK_API = url


def auth_headers() -> dict:
    """Bearer-token auth header for all Lattik Studio API calls."""
    if not LATTIK_API_TOKEN:
        raise RuntimeError(
            "LATTIK_API_TOKEN is not set — cannot authenticate to Lattik Studio API"
        )
    return {"Authorization": f"Bearer {LATTIK_API_TOKEN}"}


# ---------------------------------------------------------------------------
# Bucketing
# ---------------------------------------------------------------------------

def next_power_of_2(n: int) -> int:
    if n <= 1:
        return 1
    p = 1
    while p < n:
        p *= 2
    return min(p, MAX_BUCKETS)


def estimate_size(df: DataFrame) -> int:
    """Rough size estimate based on row count and schema width.

    Deliberately avoids `df.count()` via `df.rdd.countApprox` so we don't pay a
    full shuffle just to pick a bucket count. For small inputs (< 1 GB) the
    estimate is biased high, which is fine — it only affects bucket count,
    which is clamped to [1, MAX_BUCKETS] anyway.
    """
    count = df.count()
    avg_row_bytes = sum(
        8
        if f.dataType.simpleString() in ("bigint", "double", "long", "int")
        else 32
        for f in df.schema.fields
    )
    return count * max(1, avg_row_bytes)


def determine_bucket_levels(df: DataFrame, pk_columns: list[str]) -> list[int]:
    """
    Decide how many buckets to use at each PK level.

    The invariant is: multiplying all returned integers together yields the
    total bucket count, which is a power of two between 1 and `MAX_BUCKETS`.
    A single-PK table returns `[total_buckets]`. Composite PKs split the
    buckets across the PK columns so the first-level shuffle is cheap.
    """
    total_size = estimate_size(df)
    total_buckets = next_power_of_2(max(1, total_size // TARGET_BUCKET_SIZE))
    total_buckets = max(1, min(total_buckets, MAX_BUCKETS))

    if len(pk_columns) <= 1:
        return [total_buckets]

    level_1 = next_power_of_2(int(math.sqrt(total_buckets)))
    level_2 = max(1, total_buckets // level_1)
    if len(pk_columns) == 2:
        return [level_1, level_2]

    level_2_sub = next_power_of_2(int(math.sqrt(level_2)))
    level_3 = max(1, level_2 // level_2_sub)
    return [level_1, level_2_sub, level_3]


def apply_bucketing(
    df: DataFrame, pk_columns: list[str], bucket_levels: list[int]
) -> tuple[DataFrame, int]:
    """
    Add a `_bucket` column to `df` by hashing the PK columns hierarchically.

    Returns the bucketed DataFrame and the total number of buckets
    (`product(bucket_levels)`). The caller is responsible for repartitioning
    and sorting before writing.
    """
    total_buckets = 1
    for lvl in bucket_levels:
        total_buckets *= lvl

    df_bucketed = df
    sub_count = 1
    for i in reversed(range(len(pk_columns))):
        col = pk_columns[i]
        lvl = bucket_levels[min(i, len(bucket_levels) - 1)]
        level_col = f"_bucket_l{i}"
        df_bucketed = df_bucketed.withColumn(
            level_col, F.abs(F.xxhash64(F.col(col))) % F.lit(lvl)
        )
        if i == len(pk_columns) - 1:
            df_bucketed = df_bucketed.withColumn("_bucket", F.col(level_col))
        else:
            df_bucketed = df_bucketed.withColumn(
                "_bucket",
                F.col(level_col) * F.lit(sub_count) + F.col("_bucket"),
            )
        sub_count *= lvl

    return df_bucketed, total_buckets


# ---------------------------------------------------------------------------
# Cumulative merge (per column strategy)
# ---------------------------------------------------------------------------

def merge_cumulative(
    cumulative_df: Optional[DataFrame],
    delta_df: DataFrame,
    columns: list[dict],
    pk_columns: list[str],
) -> DataFrame:
    """
    Merge delta with previous cumulative to produce new cumulative per strategy.

    If `cumulative_df` is `None`, the delta IS the cumulative (first load /
    seed). The returned DataFrame always contains `pk_columns`, every
    cumulative column, and every `<name>__delta` column.
    """
    if cumulative_df is None:
        result = delta_df
        for col in columns:
            name = col["name"]
            delta_name = f"{name}__delta"
            result = result.withColumn(name, F.col(delta_name))
        return result

    joined = delta_df.alias("d").join(
        cumulative_df.alias("c"), on=pk_columns, how="full_outer"
    )

    for col in columns:
        name = col["name"]
        delta_name = f"{name}__delta"
        strategy = col["strategy"]
        c_col = F.col(f"c.{name}")
        d_col = F.col(f"d.{delta_name}")

        if strategy == "lifetime_window":
            agg = col.get("agg", "").lower()
            if "count" in agg or "sum" in agg:
                joined = joined.withColumn(
                    name,
                    F.coalesce(c_col, F.lit(0)) + F.coalesce(d_col, F.lit(0)),
                )
            elif "max" in agg:
                # Spark's `greatest` already ignores NULL arguments: if either
                # side is null it returns the other; if both are null it
                # returns null. No need for nested coalesce.
                joined = joined.withColumn(name, F.greatest(c_col, d_col))
            elif "min" in agg:
                joined = joined.withColumn(name, F.least(c_col, d_col))
            else:
                # Default: replace (last-writer-wins)
                joined = joined.withColumn(name, F.coalesce(d_col, c_col))

        elif strategy == "prepend_list":
            max_length = col.get("max_length", 10)
            joined = joined.withColumn(
                name,
                F.slice(
                    F.concat(
                        F.coalesce(d_col, F.array()),
                        F.coalesce(c_col, F.array()),
                    ),
                    1,
                    max_length,
                ),
            )

        elif strategy == "bitmap_activity":
            joined = joined.withColumn(
                name,
                F.when(
                    d_col.isNotNull() | c_col.isNotNull(), F.lit(1)
                ).otherwise(F.lit(0)),
            )

    # Resolve ambiguous PK columns from the full outer join
    for pk in pk_columns:
        joined = joined.withColumn(
            pk, F.coalesce(F.col(f"d.{pk}"), F.col(f"c.{pk}"))
        )

    select_cols = pk_columns.copy()
    for col in columns:
        select_cols.append(col["name"])
        select_cols.append(f"{col['name']}__delta")
    return joined.select(*select_cols)


# ---------------------------------------------------------------------------
# Load write
# ---------------------------------------------------------------------------

def write_load(
    df: DataFrame,
    table_path: str,
    pk_columns: list[str],
    column_names: list[str],
    ds: str,
    hour: Optional[int],
    mode: str = "forward",
    load_id: Optional[str] = None,
) -> tuple[str, list[int], int]:
    """
    Write a DataFrame as a new immutable load to S3.

    Returns `(load_id, bucket_levels, total_buckets)`. Uses hierarchical
    bucketing (`determine_bucket_levels`) unconditionally so forward and
    backfill drivers produce loads with compatible metadata.
    """
    load_id = load_id or str(uuid.uuid4())
    load_path = f"{table_path}/loads/{load_id}"

    bucket_levels = determine_bucket_levels(df, pk_columns)
    df_bucketed, total_buckets = apply_bucketing(df, pk_columns, bucket_levels)

    df_bucketed = df_bucketed.repartition(total_buckets, "_bucket")
    if FORMAT_ID == "parquet":
        df_bucketed = df_bucketed.sortWithinPartitions(*pk_columns)

    all_columns = pk_columns.copy()
    for name in column_names:
        all_columns.append(name)
        all_columns.append(f"{name}__delta")

    df_out = df_bucketed.select(*all_columns, "_bucket")

    load_meta = {
        "load_id": load_id,
        "timestamp": datetime.utcnow().isoformat() + "Z",
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

    spark = df.sparkSession
    load_json_rdd = spark.sparkContext.parallelize([json.dumps(load_meta, indent=2)])
    load_json_rdd.saveAsTextFile(f"s3a://{S3_BUCKET}/{load_path}/load.json")

    (
        df_out.write.mode("overwrite")
        .partitionBy("_bucket")
        .parquet(f"s3a://{S3_BUCKET}/{load_path}/data")
    )

    print(
        f"[lattik] Wrote load {load_id}: {total_buckets} buckets, "
        f"levels={bucket_levels}, format={FORMAT_ID}"
    )

    return load_id, bucket_levels, total_buckets


# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------

def commit_via_api(
    table_name: str,
    base_version: int,
    load_id: str,
    columns: dict[str, str],
    ds: str,
    hour: Optional[int],
    log_prefix: str = "lattik",
) -> int:
    """
    Commit a load via the Lattik Studio API. Retries on OCC conflict.

    Idempotency: the server dedupes on `(table_name, load_id)`, so retrying
    this call after a network error won't create a duplicate manifest. We
    still retry on OCC conflicts by rebasing.
    """
    attempts_remaining = 50  # hard cap so a pathological conflict loop fails fast
    while attempts_remaining > 0:
        attempts_remaining -= 1
        resp = requests.post(
            f"{LATTIK_API}/commit",
            headers=auth_headers(),
            json={
                "table_name": table_name,
                "base_version": base_version,
                "load_id": load_id,
                "columns": columns,
                "ds": ds,
                "hour": hour,
            },
            timeout=60,
        )
        resp.raise_for_status()
        result = resp.json()

        if result["status"] == "committed":
            note = " (idempotent replay)" if result.get("replayed") else ""
            print(
                f"[{log_prefix}] Committed version {result['version']} "
                f"for {table_name}{note}"
            )
            return result["version"]

        if result["status"] == "conflict":
            print(
                f"[{log_prefix}] OCC conflict, rebasing from v{result['base_version']}"
            )
            base_version = result["base_version"]
            continue

        raise RuntimeError(f"Commit failed: {result}")

    raise RuntimeError(
        f"commit_via_api: gave up after exhausting OCC conflict retries for {table_name}"
    )


def get_latest_version(table_name: str) -> int:
    """Return the latest committed manifest version, or 0 if none."""
    resp = requests.get(
        f"{LATTIK_API}/commit",
        headers=auth_headers(),
        params={"table": table_name, "mode": "latest"},
        timeout=30,
    )
    if resp.status_code == 404:
        return 0
    resp.raise_for_status()
    return resp.json().get("manifest_version", 0)


def get_load_for_ds(
    table_name: str, column_name: str, ds: str
) -> Optional[str]:
    """Return the load_id that produced `column_name` at `ds`, if any."""
    resp = requests.get(
        f"{LATTIK_API}/commit",
        headers=auth_headers(),
        params={
            "table": table_name,
            "mode": "ds",
            "ds": ds,
            "columns": column_name,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        return None
    return resp.json().get("columns", {}).get(column_name)
