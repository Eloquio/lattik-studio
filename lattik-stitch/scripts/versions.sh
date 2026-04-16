# Base image versions for the lattik-stitch build.
#
# Sourced by scripts/image-build.sh to construct immutable image tags. The
# values here must match the `FROM` lines in the Dockerfiles — this file is
# tag metadata, not a build-arg source of truth. If you bump a version here,
# bump the corresponding `FROM` line in Dockerfile / Dockerfile.trino at the
# same time (and rebuild both images).
#
# Tag format produced by image-build.sh:
#
#   lattik/spark-stitch:<VERSION>-spark<SPARK_VERSION>-iceberg<ICEBERG_VERSION>
#   lattik/trino-stitch:<VERSION>-trino<TRINO_VERSION>
#
# where VERSION comes from the VERSION file at the repo root.

# shellcheck disable=SC2034
SPARK_VERSION=4.0.2
# shellcheck disable=SC2034
ICEBERG_VERSION=1.10.1
# shellcheck disable=SC2034
TRINO_VERSION=480
