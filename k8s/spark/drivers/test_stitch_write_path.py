"""
Integration test: Lattik Table stitch write path.

Creates test Logger Tables in Iceberg, runs the batch aggregation,
writes bucketed loads to S3 (MinIO), and commits via the Lattik Studio API.

Usage (as a SparkApplication):
  spark-submit --master local[*] test_stitch_write_path.py

Or via SparkApplication YAML (see k8s/spark-stitch-test.yaml).
"""

import json
import os
import sys
import uuid

import requests
from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    StructType, StructField, LongType, StringType, DoubleType, IntegerType
)

from lattik_driver_utils import auth_headers, commit_via_api, next_power_of_2


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LATTIK_API = os.environ.get("LATTIK_API_URL", "http://lattik-studio.default.svc.cluster.local:3000/api/lattik")
# Set LATTIK_API_OPTIONAL=1 to allow the test to pass when the Studio API is
# unreachable. In CI leave it unset so a missing/broken API fails the test.
LATTIK_API_OPTIONAL = os.environ.get("LATTIK_API_OPTIONAL") == "1"
S3_BUCKET = "warehouse"
TABLE_NAME = "test_user_stats"
DS = "2026-04-09"


# ---------------------------------------------------------------------------
# Step 1: Create test Logger Tables in Iceberg
# ---------------------------------------------------------------------------

def create_test_data(spark: SparkSession):
    """Create two Logger Tables: ingest.signups and ingest.purchases."""
    print("[test] Creating test Logger Tables...")

    # Create namespace if not exists
    spark.sql("CREATE NAMESPACE IF NOT EXISTS iceberg.ingest")

    # -- signups --
    spark.sql("DROP TABLE IF EXISTS iceberg.ingest.signups")
    signups_schema = StructType([
        StructField("event_id", StringType(), False),
        StructField("event_timestamp", StringType(), False),
        StructField("ds", StringType(), False),
        StructField("hour", IntegerType(), False),
        StructField("user_id", LongType(), False),
        StructField("country", StringType(), True),
    ])

    signups_data = [
        ("evt-1", "2026-04-09T01:00:00Z", DS, 1, 100, "US"),
        ("evt-2", "2026-04-09T02:00:00Z", DS, 2, 200, "JP"),
        ("evt-3", "2026-04-09T03:00:00Z", DS, 3, 300, "DE"),
        ("evt-4", "2026-04-09T04:00:00Z", DS, 4, 100, "CA"),  # user 100 moved to CA
    ]

    signups_df = spark.createDataFrame(signups_data, signups_schema)
    signups_df.writeTo("iceberg.ingest.signups").createOrReplace()
    print(f"[test] Created ingest.signups with {signups_df.count()} rows")

    # -- purchases --
    spark.sql("DROP TABLE IF EXISTS iceberg.ingest.purchases")
    purchases_schema = StructType([
        StructField("event_id", StringType(), False),
        StructField("event_timestamp", StringType(), False),
        StructField("ds", StringType(), False),
        StructField("hour", IntegerType(), False),
        StructField("actor_id", LongType(), False),
        StructField("amount", DoubleType(), True),
    ])

    purchases_data = [
        ("evt-10", "2026-04-09T10:00:00Z", DS, 10, 100, 50.0),
        ("evt-11", "2026-04-09T11:00:00Z", DS, 11, 100, 75.0),
        ("evt-12", "2026-04-09T12:00:00Z", DS, 12, 300, 200.0),
        ("evt-13", "2026-04-09T13:00:00Z", DS, 13, 400, 30.0),
    ]

    purchases_df = spark.createDataFrame(purchases_data, purchases_schema)
    purchases_df.writeTo("iceberg.ingest.purchases").createOrReplace()
    print(f"[test] Created ingest.purchases with {purchases_df.count()} rows")


# ---------------------------------------------------------------------------
# Step 2: Aggregate and write loads
# ---------------------------------------------------------------------------

def aggregate_and_write(spark: SparkSession):
    """Aggregate source data per family, write bucketed loads to S3."""
    table_path = f"lattik/{TABLE_NAME}"

    # -- Family: signups --
    print("[test] Aggregating signups family...")
    signups_df = spark.sql(f"""
        SELECT
            user_id,
            max_by(country, event_timestamp) AS home_country,
            max_by(country, event_timestamp) AS home_country__delta
        FROM iceberg.ingest.signups
        WHERE ds = '{DS}'
        GROUP BY user_id
    """)
    signups_df.show()

    signups_load_id = str(uuid.uuid4())[:8]
    signups_bucket_count = next_power_of_2(1)  # tiny data → 1 bucket

    signups_bucketed = (
        signups_df
        .withColumn("_bucket", F.abs(F.xxhash64("user_id")) % F.lit(signups_bucket_count))
        .repartition(signups_bucket_count, "_bucket")
        .sortWithinPartitions("user_id")  # Parquet: sorted
    )

    # Write load.json
    load_meta = {
        "load_id": signups_load_id,
        "timestamp": "2026-04-09T14:00:00Z",
        "ds": DS,
        "hour": None,
        "mode": "forward",
        "format": "parquet",
        "bucket_levels": [signups_bucket_count],
        "bucket_count": signups_bucket_count,
        "sorted": True,
        "has_pk_index": False,
        "columns": ["home_country"],
    }
    load_json_path = f"s3a://{S3_BUCKET}/{table_path}/loads/{signups_load_id}/load.json"
    spark.sparkContext.parallelize([json.dumps(load_meta, indent=2)]).coalesce(1).saveAsTextFile(load_json_path)

    # Write data
    data_path = f"s3a://{S3_BUCKET}/{table_path}/loads/{signups_load_id}/data"
    signups_bucketed.select("user_id", "home_country", "home_country__delta").write.mode("overwrite").partitionBy("_bucket").parquet(
        # Can't use partitionBy with _bucket since it would create subdirs
        # For v1 test, just write flat
        f"s3a://{S3_BUCKET}/{table_path}/loads/{signups_load_id}/bucket=0000/data.parquet"
    )
    # Actually, let's write simpler — just the data as a single Parquet file
    signups_bucketed.select("user_id", "home_country", "home_country__delta").coalesce(1).write.mode("overwrite").parquet(
        f"s3a://{S3_BUCKET}/{table_path}/loads/{signups_load_id}/bucket=0000"
    )
    print(f"[test] Wrote signups load {signups_load_id}")

    # -- Family: purchases --
    print("[test] Aggregating purchases family...")
    purchases_df = spark.sql(f"""
        SELECT
            actor_id AS user_id,
            sum(amount) AS lifetime_revenue,
            sum(amount) AS lifetime_revenue__delta,
            count(*) AS purchase_count,
            count(*) AS purchase_count__delta
        FROM iceberg.ingest.purchases
        WHERE ds = '{DS}'
        GROUP BY actor_id
    """)
    purchases_df.show()

    purchases_load_id = str(uuid.uuid4())[:8]
    purchases_bucket_count = next_power_of_2(1)

    purchases_bucketed = (
        purchases_df
        .withColumn("_bucket", F.abs(F.xxhash64("user_id")) % F.lit(purchases_bucket_count))
        .repartition(purchases_bucket_count, "_bucket")
        .sortWithinPartitions("user_id")
    )

    load_meta_p = {
        "load_id": purchases_load_id,
        "timestamp": "2026-04-09T14:00:00Z",
        "ds": DS,
        "hour": None,
        "mode": "forward",
        "format": "parquet",
        "bucket_levels": [purchases_bucket_count],
        "bucket_count": purchases_bucket_count,
        "sorted": True,
        "has_pk_index": False,
        "columns": ["lifetime_revenue", "purchase_count"],
    }
    spark.sparkContext.parallelize([json.dumps(load_meta_p, indent=2)]).coalesce(1).saveAsTextFile(
        f"s3a://{S3_BUCKET}/{table_path}/loads/{purchases_load_id}/load.json"
    )

    purchases_bucketed.select(
        "user_id", "lifetime_revenue", "lifetime_revenue__delta",
        "purchase_count", "purchase_count__delta"
    ).coalesce(1).write.mode("overwrite").parquet(
        f"s3a://{S3_BUCKET}/{table_path}/loads/{purchases_load_id}/bucket=0000"
    )
    print(f"[test] Wrote purchases load {purchases_load_id}")

    return signups_load_id, purchases_load_id


# ---------------------------------------------------------------------------
# Step 3: Commit via API
# ---------------------------------------------------------------------------

def commit_loads(signups_load_id: str, purchases_load_id: str):
    """Commit the loads via the Lattik Studio API."""
    print("[test] Committing via API...")

    column_overrides = {
        "home_country": signups_load_id,
        "lifetime_revenue": purchases_load_id,
        "purchase_count": purchases_load_id,
    }

    # Use the shared commit helper so the test exercises the real code path
    # (bearer auth, OCC retry, idempotent replay).
    return commit_via_api(
        table_name=TABLE_NAME,
        base_version=0,
        load_id=signups_load_id,
        columns=column_overrides,
        ds=DS,
        hour=None,
        log_prefix="test",
    )


# ---------------------------------------------------------------------------
# Step 4: Verify
# ---------------------------------------------------------------------------

def verify(spark: SparkSession, signups_load_id: str, purchases_load_id: str, version: int):
    """Verify the loads on S3 and the commit in Postgres."""
    table_path = f"lattik/{TABLE_NAME}"

    # Check load files exist on S3
    print("[test] Verifying S3 load files...")
    signups_files = spark.read.parquet(
        f"s3a://{S3_BUCKET}/{table_path}/loads/{signups_load_id}/bucket=0000"
    )
    print(f"[test] Signups load: {signups_files.count()} rows")
    signups_files.show()

    purchases_files = spark.read.parquet(
        f"s3a://{S3_BUCKET}/{table_path}/loads/{purchases_load_id}/bucket=0000"
    )
    print(f"[test] Purchases load: {purchases_files.count()} rows")
    purchases_files.show()

    # Check manifest via the API (which also validates bearer auth + db state)
    print("[test] Verifying manifest on S3...")
    resp = requests.get(
        f"{LATTIK_API}/commit",
        headers=auth_headers(),
        params={"table": TABLE_NAME, "mode": "latest"},
        timeout=30,
    )
    result = resp.json()
    print(f"[test] Latest commit: {json.dumps(result, indent=2)}")

    assert result["status"] == "ok", f"Expected 'ok', got '{result['status']}'"
    assert result["manifest_version"] == version, f"Expected version {version}, got {result['manifest_version']}"

    # Check ETL time travel
    print("[test] Verifying ETL time travel...")
    resp = requests.get(
        f"{LATTIK_API}/commit",
        headers=auth_headers(),
        params={"table": TABLE_NAME, "mode": "ds", "ds": DS},
        timeout=30,
    )
    result = resp.json()
    print(f"[test] DS={DS} resolution: {json.dumps(result, indent=2)}")

    assert result["status"] == "ok", f"Expected 'ok', got '{result['status']}'"
    assert result["columns"]["home_country"] == signups_load_id
    assert result["columns"]["lifetime_revenue"] == purchases_load_id

    print("\n" + "=" * 60)
    print("[test] ALL CHECKS PASSED")
    print("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    spark = (
        SparkSession.builder
        .appName("test_stitch_write_path")
        .getOrCreate()
    )

    try:
        create_test_data(spark)
        signups_load_id, purchases_load_id = aggregate_and_write(spark)

        try:
            version = commit_loads(signups_load_id, purchases_load_id)
            verify(spark, signups_load_id, purchases_load_id, version)
        except requests.exceptions.ConnectionError as e:
            if not LATTIK_API_OPTIONAL:
                print(
                    f"[test] FAILED: Lattik API unreachable at {LATTIK_API} ({e})."
                    " Set LATTIK_API_OPTIONAL=1 to allow a partial run, or point"
                    " LATTIK_API_URL at a reachable Studio deployment.",
                    file=sys.stderr,
                )
                raise
            print(f"[test] WARNING: API not reachable ({e}). Skipping commit + verify.")
            print("[test] S3 load files were written successfully. Manual verification needed.")
            table_path = f"lattik/{TABLE_NAME}"
            print("\n[test] Signups load:")
            spark.read.parquet(
                f"s3a://{S3_BUCKET}/{table_path}/loads/{signups_load_id}/bucket=0000"
            ).show()
            print("\n[test] Purchases load:")
            spark.read.parquet(
                f"s3a://{S3_BUCKET}/{table_path}/loads/{purchases_load_id}/bucket=0000"
            ).show()
            print("\n[test] S3 WRITE PATH VERIFIED (API commit skipped)")

    finally:
        spark.stop()


if __name__ == "__main__":
    main()
