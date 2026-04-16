plugins {
    kotlin("jvm") version "2.1.0"
}

group = "com.eloquio"
version = "0.1.0"

repositories {
    mavenCentral()
}

val sparkVersion = "4.0.2"
val scalaVersion = "2.13"

dependencies {
    // Spark — provided at runtime by the Spark cluster
    compileOnly("org.apache.spark:spark-sql_$scalaVersion:$sparkVersion")
    compileOnly("org.apache.spark:spark-catalyst_$scalaVersion:$sparkVersion")

    // Arrow — for importing C Data Interface exports from Rust
    implementation("org.apache.arrow:arrow-c-data:18.1.0")
    implementation("org.apache.arrow:arrow-vector:18.1.0")
    implementation("org.apache.arrow:arrow-memory-netty:18.1.0")

    // JSON parsing for config
    implementation("com.google.code.gson:gson:2.12.1")

    // JDBC for Postgres (manifest resolution)
    implementation("org.postgresql:postgresql:42.7.6")

    // AWS SDK v2 for S3 — provided at runtime by the bundle JAR in the Spark image
    compileOnly("software.amazon.awssdk:s3:2.25.11")
}

kotlin {
    jvmToolchain(17)
}

tasks.jar {
    // Fat JAR: include all runtime dependencies (Kotlin stdlib, Gson, Arrow, PostgreSQL)
    // Spark-provided deps (spark-sql, spark-catalyst) are excluded.
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) })

    // Include the Rust native library in the JAR.
    val nativeDirs = listOf(file("/native"), file("../../target/release"))
    for (dir in nativeDirs) {
        if (dir.exists()) {
            from(fileTree(dir).matching {
                include("*.so", "*.dylib", "*.dll")
            }) {
                into("native")
            }
        }
    }
}
