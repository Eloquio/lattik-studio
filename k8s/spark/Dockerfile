# Custom Spark image for the lattik local data lake.
#
# Adds the Iceberg Spark runtime + AWS bundle on top of the official
# apache/spark image so SparkApplications can read/write tables in the
# iceberg-rest catalog and write parquet to MinIO via S3FileIO.
#
# Build:
#   docker build -t lattik/spark-iceberg:4.0.2-1.10.1 -f k8s/spark/Dockerfile .
#   kind load docker-image lattik/spark-iceberg:4.0.2-1.10.1 --name lattik
#
# Or use the wrapper:
#   pnpm spark:image-build
FROM apache/spark:4.0.2

# These two jars are everything Iceberg needs:
#   - iceberg-spark-runtime: Spark connector + Iceberg core
#   - iceberg-aws-bundle: S3FileIO + bundled AWS SDK (no hadoop-aws needed)
#
# Bumping Iceberg means changing both lines AND the image tag.
ARG ICEBERG_VERSION=1.10.1
ARG SPARK_BINARY_VERSION=4.0
ARG SCALA_BINARY_VERSION=2.13

USER root

# Hadoop version bundled in Spark 4.0.2
ARG HADOOP_VERSION=3.4.1
ARG AWS_SDK_VERSION=1.12.604

RUN set -eux; \
    cd /opt/spark/jars; \
    curl -fsSLO "https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-spark-runtime-${SPARK_BINARY_VERSION}_${SCALA_BINARY_VERSION}/${ICEBERG_VERSION}/iceberg-spark-runtime-${SPARK_BINARY_VERSION}_${SCALA_BINARY_VERSION}-${ICEBERG_VERSION}.jar"; \
    curl -fsSLO "https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-aws-bundle/${ICEBERG_VERSION}/iceberg-aws-bundle-${ICEBERG_VERSION}.jar"; \
    # hadoop-aws for s3a:// filesystem (needed for writing raw Parquet to S3).
    # hadoop-aws 3.4.x uses AWS SDK v2 — bundle provides all required classes.
    curl -fsSLO "https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-aws/${HADOOP_VERSION}/hadoop-aws-${HADOOP_VERSION}.jar"; \
    curl -fsSLO "https://repo1.maven.org/maven2/software/amazon/awssdk/bundle/2.25.11/bundle-2.25.11.jar"; \
    chown spark:spark *.jar

# Install Python dependencies for the lattik_table driver
RUN pip install --no-cache-dir requests

# Copy driver scripts into the work directory
COPY k8s/spark/drivers/ /opt/spark/work-dir/

USER spark
