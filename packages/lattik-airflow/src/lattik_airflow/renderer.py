"""LattikDagRenderer — reads DAG YAML specs from S3 and builds Airflow DAGs."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from pathlib import Path

import yaml

from airflow import DAG
from airflow.models import BaseOperator
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

from lattik_airflow.sensors import DataReadySensor

logger = logging.getLogger(__name__)


class LattikDagRenderer:
    """Read DAG YAML specs from S3 and produce Airflow DAG objects.

    Usage (in an Airflow DAG file)::

        dags = LattikDagRenderer(
            s3_endpoint="http://minio.minio.svc.cluster.local:9000",
            s3_access_key="lattik",
            s3_secret_key="lattik-local",
            s3_bucket="warehouse",
            s3_dag_prefix="airflow-dags/",
            s3_region="us-east-1",
            iceberg_rest_url="http://iceberg-rest.iceberg.svc.cluster.local:8181",
            spark_namespace="workloads",
            spark_app_template="/opt/airflow/dags/spark_app_template.yaml",
        ).generate()
        globals().update(dags)
    """

    def __init__(
        self,
        *,
        s3_endpoint: str,
        s3_access_key: str,
        s3_secret_key: str,
        s3_bucket: str = "warehouse",
        s3_dag_prefix: str = "airflow-dags/",
        s3_region: str = "us-east-1",
        iceberg_rest_url: str,
        spark_namespace: str = "workloads",
        spark_app_template: str | None = None,
        cache_ttl: int = 60,
    ):
        self.s3_endpoint = s3_endpoint
        self.s3_access_key = s3_access_key
        self.s3_secret_key = s3_secret_key
        self.s3_bucket = s3_bucket
        self.s3_dag_prefix = s3_dag_prefix
        self.s3_region = s3_region
        self.iceberg_rest_url = iceberg_rest_url
        self.spark_namespace = spark_namespace
        self.spark_app_template = spark_app_template or str(
            Path(__file__).parent / "spark_app_template.yaml"
        )
        self.cache_ttl = cache_ttl

        self._s3_client = None
        self._cache: dict = {"specs": [], "expires": 0.0}

    # ------------------------------------------------------------------
    # S3 helpers
    # ------------------------------------------------------------------

    def _get_s3(self):
        if self._s3_client is None:
            import boto3

            self._s3_client = boto3.client(
                "s3",
                endpoint_url=self.s3_endpoint,
                aws_access_key_id=self.s3_access_key,
                aws_secret_access_key=self.s3_secret_key,
                region_name=self.s3_region,
            )
        return self._s3_client

    def _list_dag_yamls(self) -> list[str]:
        s3 = self._get_s3()
        keys: list[str] = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(
            Bucket=self.s3_bucket, Prefix=self.s3_dag_prefix
        ):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.endswith((".yaml", ".yml")) and key != self.s3_dag_prefix:
                    keys.append(key)
        return keys

    def _read_yaml(self, key: str) -> dict:
        s3 = self._get_s3()
        resp = s3.get_object(Bucket=self.s3_bucket, Key=key)
        return yaml.safe_load(resp["Body"].read())

    # ------------------------------------------------------------------
    # Spec cache
    # ------------------------------------------------------------------

    def _get_dag_specs(self) -> list[dict]:
        now = time.time()
        if now < self._cache["expires"] and self._cache["specs"]:
            return self._cache["specs"]

        specs: list[dict] = []
        for key in self._list_dag_yamls():
            try:
                spec = self._read_yaml(key)
                if isinstance(spec, dict) and "dag_id" in spec:
                    specs.append(spec)
                else:
                    logger.warning(
                        "Skipping %s: missing dag_id or not a mapping", key
                    )
            except Exception:
                logger.exception("Failed to read DAG YAML %s", key)

        self._cache["specs"] = specs
        self._cache["expires"] = now + self.cache_ttl
        return specs

    # ------------------------------------------------------------------
    # DAG builder
    # ------------------------------------------------------------------

    def _create_dag(self, spec: dict) -> DAG | None:
        dag_id = spec.get("dag_id")
        if not dag_id:
            return None

        raw_defaults = spec.get("default_args", {})
        default_args = {
            "owner": raw_defaults.get("owner", "lattik"),
            "retries": raw_defaults.get("retries", 2),
            "retry_delay": timedelta(
                minutes=raw_defaults.get("retry_delay_minutes", 5)
            ),
        }

        dag = DAG(
            dag_id=dag_id,
            description=spec.get("description", ""),
            schedule=spec.get("schedule"),
            start_date=datetime(2026, 1, 1),
            catchup=False,
            default_args=default_args,
            tags=spec.get("tags", []),
        )

        tasks_by_id: dict[str, BaseOperator] = {}

        for task_spec in spec.get("tasks", []):
            task_id = task_spec.get("task_id")
            operator = task_spec.get("operator")
            config = task_spec.get("config", {})

            if not task_id or not operator:
                logger.warning(
                    "Skipping task in %s: missing task_id/operator", dag_id
                )
                continue

            if operator == "wait":
                task = DataReadySensor(
                    task_id=task_id,
                    table=config.get("table", ""),
                    iceberg_rest_url=self.iceberg_rest_url,
                    poke_interval=60,
                    timeout=3600,
                    mode="poke",
                    dag=dag,
                )
            elif operator == "spark":
                task = SparkKubernetesOperator(
                    task_id=task_id,
                    namespace=self.spark_namespace,
                    application_file=self.spark_app_template,
                    params={
                        "job_type": config.get("job_type", ""),
                        "job_name": config.get("job_name", ""),
                    },
                    delete_on_termination=True,
                    dag=dag,
                )
            else:
                logger.warning(
                    "Unknown operator '%s' in task %s (%s)",
                    operator,
                    task_id,
                    dag_id,
                )
                continue

            tasks_by_id[task_id] = task

        # Wire dependencies
        for task_spec in spec.get("tasks", []):
            task_id = task_spec.get("task_id")
            if task_id not in tasks_by_id:
                continue
            for dep_id in task_spec.get("dependencies", []):
                if dep_id in tasks_by_id:
                    tasks_by_id[dep_id] >> tasks_by_id[task_id]
                else:
                    logger.warning(
                        "Dependency '%s' not found for task '%s' in '%s'",
                        dep_id,
                        task_id,
                        dag_id,
                    )

        return dag

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate(self) -> dict[str, DAG]:
        """Read YAML specs from S3 and return a dict of ``{dag_id: DAG}``."""
        dags: dict[str, DAG] = {}
        for spec in self._get_dag_specs():
            try:
                dag = self._create_dag(spec)
                if dag:
                    dags[spec["dag_id"]] = dag
            except Exception:
                logger.exception(
                    "Failed to create DAG '%s'", spec.get("dag_id", "???")
                )
        return dags
