#!/usr/bin/env bash
#
# Build a stitch Docker image (spark or trino variant) and kind-load it.
#
# Usage:
#   scripts/image-build.sh spark  [--force]
#   scripts/image-build.sh trino  [--force]
#
# Each invocation produces two tags for the same built image:
#
#   Spark variant:
#     lattik/spark-stitch:<VERSION>-spark<SPARK_VERSION>-iceberg<ICEBERG_VERSION>
#     lattik/spark-stitch:dev-spark<SPARK_VERSION>
#
#   Trino variant:
#     lattik/trino-stitch:<VERSION>-trino<TRINO_VERSION>
#     lattik/trino-stitch:dev-trino<TRINO_VERSION>
#
# The first tag is immutable — pin to it from downstream manifests (e.g.
# lattik-studio SparkApplications). The second tag floats and is intended
# for local iteration where you don't want to edit manifests per rebuild.
#
# VERSION is read from the VERSION file at the repo root.
# SPARK_VERSION / ICEBERG_VERSION / TRINO_VERSION are read from
# scripts/versions.sh and must match the `FROM` lines in the Dockerfiles.
#
# If the working tree has uncommitted changes, the immutable tag gets a
# "-dirty" suffix so unreproducible artifacts are visible in image listings.
#
# Immutability guard: the immutable pin tag is checked against the local
# Docker daemon before building. If it already exists, the build refuses to
# overwrite it — the pin tag is supposed to be content-addressed by
# convention, and silently reassigning it to new content defeats the point
# of having versioned tags at all. Resolution options are:
#
#   1. Bump VERSION (and re-run — the new tag won't collide)
#   2. Pass --force (or FORCE=1 from make) to overwrite deliberately
#   3. Remove the local image with `docker image rm <tag>`
#
# Dirty builds (working tree has uncommitted changes) are NEVER guarded —
# the -dirty suffix already marks them as unreproducible and they are
# expected to be overwritten freely. The floating dev-* tag is also never
# guarded; it is meant to be reassigned on every build.
#
# NOTE: The Trino Dockerfile's Stage 3 currently hardcodes the Maven
# artifact path `target/lattik-trino-0.1.0/`. Bumping VERSION past 0.1.0
# therefore also requires bumping the `<version>` in java/lattik-trino/pom.xml
# and the corresponding COPY line in Dockerfile.trino. Tracked as a
# follow-up — the right fix is to pass VERSION as a docker build-arg and
# have both the POM and the COPY line read from it.

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
stitch_dir=$(cd "${script_dir}/.." && pwd)

# shellcheck source=./versions.sh
source "${script_dir}/versions.sh"

version_file="${stitch_dir}/VERSION"
if [[ ! -f "$version_file" ]]; then
  echo "error: VERSION file not found at $version_file" >&2
  exit 1
fi
VERSION=$(tr -d '[:space:]' < "$version_file")
if [[ -z "$VERSION" ]]; then
  echo "error: VERSION file is empty" >&2
  exit 1
fi

variant=""
force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    spark|trino)
      if [[ -n "$variant" ]]; then
        echo "error: variant specified twice: '$variant' and '$1'" >&2
        exit 2
      fi
      variant="$1"
      ;;
    -f|--force)
      force=1
      ;;
    -h|--help)
      echo "usage: $(basename "$0") spark|trino [--force]"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo "usage: $(basename "$0") spark|trino [--force]" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "$variant" ]]; then
  echo "usage: $(basename "$0") spark|trino [--force]" >&2
  exit 2
fi

case "$variant" in
  spark)
    dockerfile="${stitch_dir}/Dockerfile"
    image="lattik/spark-stitch"
    pin_suffix="spark${SPARK_VERSION}-iceberg${ICEBERG_VERSION}"
    dev_suffix="spark${SPARK_VERSION}"
    ;;
  trino)
    dockerfile="${stitch_dir}/Dockerfile.trino"
    image="lattik/trino-stitch"
    pin_suffix="trino${TRINO_VERSION}"
    dev_suffix="trino${TRINO_VERSION}"
    ;;
esac

pin_version="${VERSION}"
if ! git -C "$stitch_dir" diff --quiet HEAD; then
  pin_version="${pin_version}-${pin_suffix}-dirty"
else
  pin_version="${pin_version}-${pin_suffix}"
fi

tag_pin="${image}:${pin_version}"
tag_dev="${image}:dev-${dev_suffix}"

# Immutability guard. The clean (non-dirty) pin tag is content-addressed by
# convention — if it already exists locally, overwriting it with a new build
# silently breaks downstream pins. Refuse unless --force was passed.
if [[ "$pin_version" != *-dirty ]] && [[ $force -eq 0 ]]; then
  if docker image inspect "$tag_pin" >/dev/null 2>&1; then
    cat >&2 <<EOF
error: immutable tag already exists in the local Docker daemon:

  ${tag_pin}

Running the build would silently reassign this tag to new content, which
is exactly what the versioned tag scheme is supposed to prevent. Pick one:

  1. Bump VERSION in ${stitch_dir}/VERSION and re-run.
  2. Pass --force to overwrite the existing tag. Use this only when you are
     deliberately reproducing a prior build (same VERSION, same code).
  3. Remove the local image first:
       docker image rm ${tag_pin}

The floating ${tag_dev} tag is NOT subject to this check — it is meant to
be reassigned on every build.
EOF
    exit 1
  fi
fi

echo "==> building ${tag_pin}"
echo "    also tagged ${tag_dev}"
docker build \
  -t "$tag_pin" \
  -t "$tag_dev" \
  -f "$dockerfile" \
  "$stitch_dir"

echo "==> loading into kind cluster 'lattik'"
kind load docker-image "$tag_pin" --name lattik
kind load docker-image "$tag_dev" --name lattik

echo "==> done: ${tag_pin} and ${tag_dev}"
