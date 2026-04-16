package com.eloquio.lattik.spark

import org.apache.spark.sql.connector.read.InputPartition

/**
 * Serializable partition spec for a stitch operation.
 * Carries enough info for the executor-side PartitionReader to create
 * a Rust stitch session via JNI.
 */
data class StitchPartition(
    val tableName: String,
    val loadInfos: List<LattikScan.LoadReadInfo>,
    val warehouse: String,
    val pkColumns: List<String> = emptyList(),
    val columnTypes: Map<String, String> = emptyMap(), // column_name → arrow type string
    val stitcherId: String = "naive",
    val pkFilter: Map<String, Any>? = null, // PK filter spec for IndexedStitcher
) : InputPartition, java.io.Serializable
