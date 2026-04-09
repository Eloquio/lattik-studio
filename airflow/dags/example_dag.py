"""Smoke-test DAG: confirms KubernetesExecutor spawns worker pods successfully."""

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.bash import BashOperator
from airflow.operators.python import PythonOperator


def hello_from_worker():
    import socket
    print(f"Hello from worker pod {socket.gethostname()}")


with DAG(
    dag_id="lattik_smoke_test",
    description="Smoke test for the local Airflow + KubernetesExecutor setup",
    start_date=datetime(2026, 1, 1),
    schedule=None,
    catchup=False,
    default_args={
        "owner": "lattik",
        "retries": 0,
        "retry_delay": timedelta(minutes=1),
    },
    tags=["lattik", "smoke-test"],
) as dag:
    print_date = BashOperator(
        task_id="print_date",
        bash_command="date && echo 'running on' $(hostname)",
    )

    say_hello = PythonOperator(
        task_id="say_hello",
        python_callable=hello_from_worker,
    )

    print_date >> say_hello
