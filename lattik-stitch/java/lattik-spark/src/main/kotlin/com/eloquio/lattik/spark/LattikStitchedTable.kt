package com.eloquio.lattik.spark

import com.google.gson.Gson
import org.apache.spark.sql.connector.catalog.SupportsRead
import org.apache.spark.sql.connector.catalog.Table
import org.apache.spark.sql.connector.catalog.TableCapability
import org.apache.spark.sql.connector.read.ScanBuilder
import org.apache.spark.sql.types.DataTypes
import org.apache.spark.sql.types.Metadata
import org.apache.spark.sql.types.StructField
import org.apache.spark.sql.types.StructType
import org.apache.spark.sql.util.CaseInsensitiveStringMap
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import java.net.URI

/**
 * A Lattik Table as seen by Spark — stitches multiple loads at read time.
 */
class LattikStitchedTable(
    private val tableName: String,
    private val manifestVersion: Int,
    private val manifestLoadId: String,
    private val warehouse: String,
    private val jdbcUrl: String,
    private val maxStitchLoads: Int,
    private val specJson: String? = null,
) : Table, SupportsRead {

    // The manifest is fetched lazily and cached
    private val manifest: Manifest by lazy { fetchManifest() }

    // PK columns extracted from the table spec
    private val pkColumns: List<String> by lazy { extractPkColumns() }
    private val bucketName: String by lazy {
        warehouse.removePrefix("s3://").removePrefix("s3a://").trimEnd('/')
    }
    private val loadMetadataById: Map<String, LoadMetadata> by lazy { fetchLoadMetadata() }

    override fun name(): String = tableName

    override fun schema(): StructType {
        val fields = mutableListOf<StructField>()

        // PK columns first (from the table spec)
        for (pk in pkColumns) {
            fields.add(StructField(pk, DataTypes.LongType, false, Metadata.empty()))
        }

        // Payload columns — infer types from load.json or Parquet file schema.
        // For now, read the first Parquet file from each load to discover the actual types.
        val columnTypes = inferColumnTypes()

        for (colName in manifest.columns.keys) {
            if (colName !in pkColumns) {
                val dataType = columnTypes[colName] ?: DataTypes.StringType
                fields.add(StructField(colName, dataType, true, Metadata.empty()))
            }
        }

        return StructType(fields.toTypedArray())
    }

    /**
     * Infer column types from the table spec's column strategy definitions.
     * - lifetime_window with agg containing "sum" or "avg" → DoubleType
     * - lifetime_window with agg containing "count" → LongType
     * - lifetime_window with agg containing "max" or "min" → DoubleType
     * - prepend_list → StringType (list serialized as string for now)
     * - bitmap_activity → BinaryType
     */
    private fun inferColumnTypes(): Map<String, org.apache.spark.sql.types.DataType> {
        if (specJson == null) return emptyMap()
        val types = mutableMapOf<String, org.apache.spark.sql.types.DataType>()
        val spec = Gson().fromJson(specJson, Map::class.java)
        val families = spec["column_families"] as? List<*> ?: return emptyMap()

        for (family in families) {
            val familyMap = family as? Map<*, *> ?: continue
            val columns = familyMap["columns"] as? List<*> ?: continue
            for (col in columns) {
                val colMap = col as? Map<*, *> ?: continue
                val name = colMap["name"] as? String ?: continue
                val strategy = colMap["strategy"] as? String ?: continue

                types[name] = when (strategy) {
                    "lifetime_window" -> {
                        val agg = (colMap["agg"] as? String)?.lowercase() ?: ""
                        when {
                            agg.contains("count") -> DataTypes.LongType
                            agg.contains("sum") || agg.contains("avg") -> DataTypes.DoubleType
                            agg.contains("max") || agg.contains("min") -> DataTypes.DoubleType
                            else -> DataTypes.DoubleType
                        }
                    }
                    "prepend_list" -> DataTypes.StringType
                    "bitmap_activity" -> DataTypes.BinaryType
                    else -> DataTypes.StringType
                }
            }
        }
        return types
    }

    private fun extractPkColumns(): List<String> {
        if (specJson == null) return emptyList()
        val spec = Gson().fromJson(specJson, Map::class.java)
        val primaryKey = spec["primary_key"] as? List<*> ?: return emptyList()
        return primaryKey.mapNotNull { pk ->
            (pk as? Map<*, *>)?.get("column") as? String
        }
    }

    override fun capabilities(): MutableSet<TableCapability> {
        return mutableSetOf(TableCapability.BATCH_READ)
    }

    override fun newScanBuilder(options: CaseInsensitiveStringMap): ScanBuilder {
        return LattikScanBuilder(
            tableName = tableName,
            manifest = manifest,
            loadMetadataById = loadMetadataById,
            warehouse = warehouse,
            jdbcUrl = jdbcUrl,
            maxStitchLoads = maxStitchLoads,
            pkColumns = pkColumns,
            tableSchema = schema(),
        )
    }

    private fun fetchManifest(): Manifest {
        val s3Endpoint = System.getenv("S3_ENDPOINT") ?: "http://minio.minio.svc.cluster.local:9000"
        val s3AccessKey = System.getenv("AWS_ACCESS_KEY_ID") ?: "lattik"
        val s3SecretKey = System.getenv("AWS_SECRET_ACCESS_KEY") ?: "lattik-local"
        val s3Region = System.getenv("AWS_REGION") ?: "us-east-1"

        val s3 = S3Client.builder()
            .endpointOverride(URI.create(s3Endpoint))
            .region(Region.of(s3Region))
            .credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create(s3AccessKey, s3SecretKey)
            ))
            .forcePathStyle(true)
            .build()

        val key = "lattik/$tableName/manifests/v${manifestVersion.toString().padStart(4, '0')}_$manifestLoadId.json"
        val response = s3.getObject(GetObjectRequest.builder()
            .bucket(bucketName)
            .key(key)
            .build())

        val body = response.readAllBytes().decodeToString()
        s3.close()

        return Gson().fromJson(body, Manifest::class.java)
    }

    private fun fetchLoadMetadata(): Map<String, LoadMetadata> {
        val s3Endpoint = System.getenv("S3_ENDPOINT") ?: "http://minio.minio.svc.cluster.local:9000"
        val s3AccessKey = System.getenv("AWS_ACCESS_KEY_ID") ?: "lattik"
        val s3SecretKey = System.getenv("AWS_SECRET_ACCESS_KEY") ?: "lattik-local"
        val s3Region = System.getenv("AWS_REGION") ?: "us-east-1"

        val s3 = S3Client.builder()
            .endpointOverride(URI.create(s3Endpoint))
            .region(Region.of(s3Region))
            .credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create(s3AccessKey, s3SecretKey)
            ))
            .forcePathStyle(true)
            .build()

        s3.use { client ->
            return manifest.columns.values.distinct().associateWith { loadId ->
                val key = "lattik/$tableName/loads/$loadId/load.json"
                val response = client.getObject(
                    GetObjectRequest.builder()
                        .bucket(bucketName)
                        .key(key)
                        .build()
                )
                val body = response.readAllBytes().decodeToString()
                Gson().fromJson(body, LoadMetadata::class.java)
            }
        }
    }

    data class Manifest(
        val version: Int,
        val columns: Map<String, String>, // column_name → load_id
    )

    data class LoadMetadata(
        val load_id: String,
        val format: String,
        val sorted: Boolean,
        val has_pk_index: Boolean,
    )
}
