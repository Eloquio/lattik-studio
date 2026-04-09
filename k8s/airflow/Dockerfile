# Custom Airflow image for Lattik.
# Installs the lattik-airflow package (DAG renderer) and the CNCF Kubernetes
# provider (SparkKubernetesOperator).
#
# Build & load into the kind cluster:
#   pnpm airflow:image-build

FROM apache/airflow:3.2.0

COPY --chown=airflow:0 packages/lattik-airflow /tmp/lattik-airflow

RUN pip install --no-cache-dir /tmp/lattik-airflow \
    && rm -rf /tmp/lattik-airflow
