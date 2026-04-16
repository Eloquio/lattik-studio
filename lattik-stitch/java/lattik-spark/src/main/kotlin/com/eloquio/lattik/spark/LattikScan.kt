package com.eloquio.lattik.spark

import org.apache.spark.sql.connector.read.*
import org.apache.spark.sql.sources.Filter
import org.apache.spark.sql.types.DataTypes
import org.apache.spark.sql.types.Metadata
import org.apache.spark.sql.types.StructField
import org.apache.spark.sql.types.StructType

/**
 * Spark Scan implementation for Lattik Tables.
 * Declares columnar read support and plans StitchPartitions.
 */
class LattikScan(
    private val tableName: String,
    private val loadInfos: List<LoadReadInfo>,
    private val warehouse: String,
    private val pushedFilters: Array<Filter>,
    private val pkColumns: List<String> = emptyList(),
    private val tableSchema: StructType? = null,
    private val stitcherId: String = "naive",
    private val pkFilter: Map<String, Any>? = null,
) : Scan, Batch {

    override fun readSchema(): StructType {
        // Return only the columns that were requested (after pruning).
        // The schema must match the ColumnarBatch produced by the reader.
        if (tableSchema == null) return StructType(emptyArray())

        // Build the pruned schema: PK columns + requested payload columns
        val requestedColumns = loadInfos.flatMap { it.columns }.distinct().toSet()
        val fields = mutableListOf<StructField>()

        for (field in tableSchema.fields()) {
            if (field.name() in pkColumns || field.name() in requestedColumns) {
                fields.add(field)
            }
        }

        return StructType(fields.toTypedArray())
    }

    override fun toBatch(): Batch = this

    override fun planInputPartitions(): Array<InputPartition> {
        // For v1: create one partition per load (each partition reads one load's data).
        // The NaiveStitcher in Rust handles the cross-load join.
        // Future: expand to per-bucket partitions for parallelism.
        // Convert Spark schema types to Arrow type strings for the Rust core
        val columnTypes = mutableMapOf<String, String>()
        if (tableSchema != null) {
            for (field in tableSchema.fields()) {
                columnTypes[field.name()] = when (field.dataType()) {
                    DataTypes.LongType -> "int64"
                    DataTypes.IntegerType -> "int32"
                    DataTypes.DoubleType -> "double"
                    DataTypes.FloatType -> "float"
                    DataTypes.BooleanType -> "boolean"
                    DataTypes.StringType -> "string"
                    DataTypes.BinaryType -> "binary"
                    DataTypes.DateType -> "date"
                    DataTypes.TimestampType -> "timestamp"
                    else -> "string"
                }
            }
        }

        return arrayOf(
            StitchPartition(
                tableName = tableName,
                loadInfos = loadInfos,
                warehouse = warehouse,
                pkColumns = pkColumns,
                columnTypes = columnTypes,
                stitcherId = stitcherId,
                pkFilter = pkFilter,
            )
        )
    }

    override fun createReaderFactory(): PartitionReaderFactory {
        return StitchPartitionReaderFactory()
    }

    data class LoadReadInfo(
        val loadId: String,
        val columns: List<String>,
        val formatId: String,
        val sorted: Boolean,
        val hasPkIndex: Boolean,
    ) : java.io.Serializable
}
