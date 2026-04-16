# Building Trino Connector Plugins

> Notes on building a custom Trino connector for Trino 480+.

## JDK Requirements

Trino 480 requires **JDK 25**. The SPI classes are compiled with class file version 69.0 (JDK 25). You cannot compile against the Trino SPI with any earlier JDK — the class files will fail to load.

The Trino Docker image (`trinodb/trino:480`) ships with Temurin `jdk-25.0.2+10` at `/usr/lib/jvm/jdk-25.0.2+10`.

## Build System: Maven (not Gradle)

**Use Maven.** The entire Trino ecosystem is Maven-based:

- Trino itself uses Maven 3.9.13 via `./mvnw`
- The `trino-maven-plugin` provides the `trino-plugin` packaging type
- All community connectors use Maven
- Maven 3.9.x works fine with JDK 25

Gradle does NOT support JDK 25 until Gradle 9.1.0+. Gradle 8.x (the latest widely available) cannot compile against the Trino 480 SPI. Don't fight this — use Maven.

## Parent POM

Use `io.airlift:airbase` as the parent POM. This is the same parent Trino itself uses. It provides:

- Dependency management for common libraries (Jackson, Guava, Guice, etc.)
- Compiler plugin configuration for JDK 25
- The `air.java.version` and `project.build.targetJdk` properties

For Trino 480: `airbase` version `364`.

## Minimal pom.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>io.airlift</groupId>
        <artifactId>airbase</artifactId>
        <version>364</version>
    </parent>

    <groupId>com.eloquio</groupId>
    <artifactId>lattik-trino</artifactId>
    <version>0.1.0</version>
    <packaging>trino-plugin</packaging>

    <properties>
        <project.build.targetJdk>25</project.build.targetJdk>
        <air.java.version>25</air.java.version>
        <dep.trino.version>480</dep.trino.version>
    </properties>

    <dependencies>
        <!-- Trino SPI — provided at runtime -->
        <dependency>
            <groupId>io.trino</groupId>
            <artifactId>trino-spi</artifactId>
            <version>${dep.trino.version}</version>
            <scope>provided</scope>
        </dependency>

        <!-- Your runtime dependencies here -->
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>io.trino</groupId>
                <artifactId>trino-maven-plugin</artifactId>
                <version>17</version>
                <extensions>true</extensions>
            </plugin>
            <plugin>
                <groupId>ca.vanzyl.provisio.maven.plugins</groupId>
                <artifactId>provisio-maven-plugin</artifactId>
                <version>1.1.1</version>
                <extensions>true</extensions>
            </plugin>
        </plugins>
    </build>
</project>
```

## What `trino-maven-plugin` provides

- **`trino-plugin` packaging type**: tells Maven how to assemble the plugin
- **Service descriptor generation**: auto-generates `META-INF/services/io.trino.spi.Plugin`
- **Dependency scope validation**: warns if provided-scope dependencies are missing
- **Plugin ZIP assembly**: creates a ZIP file containing all JARs (via provisio-maven-plugin)

## Plugin directory structure

Trino expects plugins at `/usr/lib/trino/plugin/<name>/`:

```
/usr/lib/trino/plugin/lattik/
    lattik-trino-0.1.0.jar           ← your plugin JAR
    gson-2.12.1.jar                  ← runtime dependencies
    postgresql-42.7.6.jar
    arrow-c-data-18.1.0.jar
    ...                              ← all JARs flat, no subdirectories
    liblattik_stitch_jni.so          ← native libraries go here too
```

Rules:
- One directory per plugin under `plugin/`
- Only JAR files and native libraries in the directory
- `trino-spi`, `slice`, `jackson-annotations`, `opentelemetry-api` are NOT included (provided by Trino)
- One JAR must contain `META-INF/services/io.trino.spi.Plugin`

## Docker build

```dockerfile
# Stage 1: Build Rust native lib
FROM rust:1.87-bookworm AS rust-builder
...
RUN cargo build --release -p lattik-stitch-jni

# Stage 2: Build Trino plugin with Maven + JDK 25
FROM maven:3.9-eclipse-temurin-25 AS java-builder
COPY java/lattik-trino/pom.xml .
RUN mvn dependency:go-offline
COPY java/lattik-trino/src/ src/
RUN mvn package -DskipTests

# Stage 3: Assemble Trino image
FROM trinodb/trino:480
COPY --from=java-builder target/lattik-trino-0.1.0/ /usr/lib/trino/plugin/lattik/
COPY --from=rust-builder target/release/liblattik_stitch_jni.so /usr/lib/trino/plugin/lattik/
```

The `mvn package` produces `target/lattik-trino-0.1.0/` (a directory) containing all plugin JARs.

## Catalog configuration

Create `/etc/trino/catalog/lattik.properties`:

```properties
connector.name=lattik
warehouse=s3://warehouse
jdbc-url=jdbc:postgresql://postgres:5432/lattik_studio?user=lattik&password=lattik-local
max-stitch-loads=3
```

## References

- Trino SPI docs: https://trino.io/docs/current/develop/spi-overview.html
- Trino connector guide: https://trino.io/docs/current/develop/connectors.html
- Example HTTP connector: `trinodb/trino` → `plugin/trino-example-http/pom.xml`
- Community connector example: `nineinchnick/trino-openapi`
- Airbase parent POM: `io.airlift:airbase:364`
