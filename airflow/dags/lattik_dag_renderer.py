"""Lattik dynamic DAG renderer — thin entry point for Airflow's dag-processor."""

import os

from lattik_airflow import LattikDagRenderer

dags = LattikDagRenderer(
    s3_endpoint=os.environ.get(
        "LATTIK_S3_ENDPOINT", "http://minio.minio.svc.cluster.local:9000"
    ),
    s3_access_key=os.environ.get("LATTIK_S3_ACCESS_KEY", "lattik"),
    s3_secret_key=os.environ.get("LATTIK_S3_SECRET_KEY", "lattik-local"),
    s3_bucket=os.environ.get("LATTIK_S3_BUCKET", "warehouse"),
    s3_dag_prefix=os.environ.get("LATTIK_S3_DAG_PREFIX", "airflow-dags/"),
    s3_region=os.environ.get("LATTIK_S3_REGION", "us-east-1"),
    iceberg_rest_url=os.environ.get(
        "LATTIK_ICEBERG_REST_URL",
        "http://iceberg-rest.iceberg.svc.cluster.local:8181",
    ),
    spark_namespace=os.environ.get("LATTIK_SPARK_NAMESPACE", "workloads"),
    spark_app_template=os.path.join(
        os.path.dirname(__file__), "spark_app_template.yaml"
    ),
).generate()

globals().update(dags)
