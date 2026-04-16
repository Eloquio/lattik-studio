package com.eloquio.lattik.spark

import com.eloquio.lattik.stitch.LattikStitchJni
import com.google.gson.Gson
import org.apache.arrow.c.ArrowArray
import org.apache.arrow.c.ArrowSchema
import org.apache.arrow.c.CDataDictionaryProvider
import org.apache.arrow.c.Data
import org.apache.arrow.memory.RootAllocator
import org.apache.spark.sql.catalyst.InternalRow
import org.apache.spark.sql.connector.read.InputPartition
import org.apache.spark.sql.connector.read.PartitionReader
import org.apache.spark.sql.connector.read.PartitionReaderFactory
import org.apache.spark.sql.vectorized.ArrowColumnVector
import org.apache.spark.sql.vectorized.ColumnVector
import org.apache.spark.sql.vectorized.ColumnarBatch

/**
 * Creates StitchPartitionReaders that delegate to the Rust core via JNI.
 */
class StitchPartitionReaderFactory : PartitionReaderFactory, java.io.Serializable {

    override fun createReader(partition: InputPartition): PartitionReader<InternalRow> {
        throw UnsupportedOperationException("Use createColumnarReader for vectorized reads")
    }

    override fun createColumnarReader(partition: InputPartition): PartitionReader<ColumnarBatch> {
        val stitchPartition = partition as StitchPartition
        return StitchPartitionReader(stitchPartition)
    }

    override fun supportColumnarReads(partition: InputPartition): Boolean = true
}

/**
 * Reads stitched data from the Rust core via JNI.
 *
 * The reader creates a Rust-side stitch session on construction,
 * then repeatedly calls nextBatch() to get Arrow RecordBatches
 * via the C Data Interface (zero-copy).
 *
 * Lifecycle:
 * 1. Constructor: create Rust session + Arrow allocator
 * 2. next(): check if more batches available
 * 3. get(): import Arrow data from Rust → Spark ColumnarBatch
 * 4. close(): release Rust session + Arrow allocator
 */
class StitchPartitionReader(
    private val partition: StitchPartition,
) : PartitionReader<ColumnarBatch> {

    private val rustSessionHandle: Long
    private val allocator = RootAllocator()
    private var currentBatch: ColumnarBatch? = null

    init {
        // Build the JSON config for the Rust session
        val s3Endpoint = System.getenv("S3_ENDPOINT") ?: "http://minio.minio.svc.cluster.local:9000"
        val s3Region = System.getenv("AWS_REGION") ?: "us-east-1"
        val s3AccessKey = System.getenv("AWS_ACCESS_KEY_ID") ?: "lattik"
        val s3SecretKey = System.getenv("AWS_SECRET_ACCESS_KEY") ?: "lattik-local"

        // Parse bucket name from warehouse (e.g., "s3://warehouse" → "warehouse")
        val bucket = partition.warehouse.removePrefix("s3://").removePrefix("s3a://").trimEnd('/')

        require(partition.loadInfos.isNotEmpty()) {
            "Stitch partition for ${partition.tableName} has no load specs"
        }

        val loadSpecs = partition.loadInfos.map { loadInfo ->
            mapOf(
                "load_id" to loadInfo.loadId,
                "path" to "lattik/${partition.tableName}/loads/${loadInfo.loadId}",
                "columns" to loadInfo.columns,
                "pk_columns" to partition.pkColumns,
                "format_id" to loadInfo.formatId,
                "sorted" to loadInfo.sorted,
                "has_pk_index" to loadInfo.hasPkIndex,
            )
        }

        // Build output_columns with types from the spec (passed through the partition)
        val outputColumns = partition.columnTypes.map { (name, type) ->
            mapOf("name" to name, "data_type" to type)
        }

        val configMap = mutableMapOf<String, Any>(
            "load_specs" to loadSpecs,
            "pk_columns" to partition.pkColumns,
            "stitcher_id" to partition.stitcherId,
            "output_columns" to outputColumns,
            "s3_config" to mapOf(
                "endpoint" to s3Endpoint,
                "region" to s3Region,
                "bucket" to bucket,
                "access_key_id" to s3AccessKey,
                "secret_access_key" to s3SecretKey,
            ),
        )
        // Include PK filter if present (for IndexedStitcher)
        if (partition.pkFilter != null) {
            configMap["pk_filter"] = partition.pkFilter
        }

        val config: Map<String, Any> = configMap

        val configJson = Gson().toJson(config)
        rustSessionHandle = LattikStitchJni.createSession(configJson)
        require(rustSessionHandle != 0L) {
            "Failed to create native stitch session for ${partition.tableName}"
        }
    }

    override fun next(): Boolean {
        // Release the previous batch before fetching the next one
        currentBatch?.close()
        currentBatch = null

        return LattikStitchJni.hasNext(rustSessionHandle)
    }

    override fun get(): ColumnarBatch {
        // Allocate Arrow C Data Interface structs
        val arrowSchema = ArrowSchema.allocateNew(allocator)
        val arrowArray = ArrowArray.allocateNew(allocator)

        try {
            // Call Rust to fill in the schema + array via the C Data Interface
            val produced = LattikStitchJni.nextBatch(
                rustSessionHandle,
                arrowSchema.memoryAddress(),
                arrowArray.memoryAddress(),
            )

            if (!produced) {
                arrowSchema.close()
                arrowArray.close()
                // Return empty batch
                return ColumnarBatch(emptyArray(), 0)
            }

            // Import from Arrow C Data Interface into Java Arrow vectors.
            // importVectorSchemaRoot consumes (releases) both arrowSchema and arrowArray.
            val dictProvider = CDataDictionaryProvider()
            val root = Data.importVectorSchemaRoot(allocator, arrowArray, arrowSchema, dictProvider)

            // Wrap Arrow FieldVectors as Spark ColumnVectors
            val fieldVectors = root.fieldVectors
            val columns = Array<ColumnVector>(fieldVectors.size) { i ->
                ArrowColumnVector(fieldVectors[i])
            }

            val batch = ColumnarBatch(columns)
            batch.setNumRows(root.rowCount)

            // Store for cleanup on next() or close()
            currentBatch = batch
            return batch

        } catch (e: Exception) {
            arrowSchema.close()
            arrowArray.close()
            throw e
        }
    }

    override fun close() {
        currentBatch?.close()
        currentBatch = null
        LattikStitchJni.closeSession(rustSessionHandle)
        allocator.close()
    }
}
