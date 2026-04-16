package com.eloquio.lattik.spark

import org.apache.spark.sql.connector.read.Scan
import org.apache.spark.sql.connector.read.ScanBuilder
import org.apache.spark.sql.connector.read.SupportsPushDownFilters
import org.apache.spark.sql.connector.read.SupportsPushDownRequiredColumns
import org.apache.spark.sql.sources.EqualTo
import org.apache.spark.sql.sources.Filter
import org.apache.spark.sql.sources.In
import org.apache.spark.sql.types.StructType

/**
 * Builds a LattikScan, handling column pruning, predicate pushdown,
 * and stitcher selection (NaiveStitcher vs IndexedStitcher).
 */
class LattikScanBuilder(
    private val tableName: String,
    private val manifest: LattikStitchedTable.Manifest,
    private val loadMetadataById: Map<String, LattikStitchedTable.LoadMetadata>,
    private val warehouse: String,
    private val jdbcUrl: String,
    private val maxStitchLoads: Int,
    private val pkColumns: List<String> = emptyList(),
    private val tableSchema: org.apache.spark.sql.types.StructType? = null,
) : ScanBuilder, SupportsPushDownRequiredColumns, SupportsPushDownFilters {

    private var requiredSchema: StructType? = null
    private var pushedFilters: Array<Filter> = emptyArray()

    override fun pruneColumns(requiredSchema: StructType) {
        this.requiredSchema = requiredSchema
    }

    override fun pushFilters(filters: Array<Filter>): Array<Filter> {
        val pkFilter = filters.firstOrNull { isPkFilter(it) }
        this.pushedFilters = pkFilter?.let { arrayOf(it) } ?: emptyArray()
        return filters.filterNot { it === pkFilter }.toTypedArray()
    }

    override fun pushedFilters(): Array<Filter> = pushedFilters

    override fun build(): Scan {
        // Determine which columns are needed
        val neededColumns = requiredSchema?.fieldNames()?.toSet()
            ?: (pkColumns + manifest.columns.keys).toSet()
        val neededPayloadColumns = neededColumns - pkColumns.toSet()

        // Map columns to load IDs
        val columnToLoad = mutableMapOf<String, String>()
        for (col in neededPayloadColumns) {
            val loadId = manifest.columns[col]
            if (loadId != null) {
                columnToLoad[col] = loadId
            }
        }

        // Group columns by load ID
        val loadToColumns = columnToLoad.entries
            .groupBy({ it.value }, { it.key })

        val loadInfos = if (neededPayloadColumns.isEmpty()) {
            manifest.columns.values.distinct().map { loadId ->
                val metadata = loadMetadataById[loadId]
                    ?: throw RuntimeException("Missing load metadata for $loadId")
                LattikScan.LoadReadInfo(
                    loadId = loadId,
                    columns = emptyList(),
                    formatId = metadata.format,
                    sorted = metadata.sorted,
                    hasPkIndex = metadata.has_pk_index,
                )
            }
        } else {
            loadToColumns.map { (loadId, columns) ->
                val metadata = loadMetadataById[loadId]
                    ?: throw RuntimeException("Missing load metadata for $loadId")
                LattikScan.LoadReadInfo(
                    loadId = loadId,
                    columns = columns,
                    formatId = metadata.format,
                    sorted = metadata.sorted,
                    hasPkIndex = metadata.has_pk_index,
                )
            }
        }

        // SELECT * guardrail
        val distinctLoads = loadInfos.size
        if (requiredSchema == null && distinctLoads > maxStitchLoads) {
            throw RuntimeException(
                "SELECT * on lattik.$tableName requires stitching $distinctLoads loads. " +
                "Max allowed without explicit column selection: $maxStitchLoads. " +
                "Specify the columns you need."
            )
        }

        // Detect PK filter for IndexedStitcher selection
        val pkFilter = extractPkFilter()
        val stitcherId = if (pkFilter != null) "indexed" else "naive"

        return LattikScan(
            tableName = tableName,
            loadInfos = loadInfos,
            warehouse = warehouse,
            pushedFilters = pushedFilters,
            pkColumns = pkColumns,
            tableSchema = tableSchema,
            stitcherId = stitcherId,
            pkFilter = pkFilter,
        )
    }

    /**
     * Check if a filter is a PK equality or IN filter.
     */
    private fun isPkFilter(filter: Filter): Boolean {
        return when (filter) {
            is EqualTo -> filter.attribute() in pkColumns
            is In -> filter.attribute() in pkColumns
            else -> false
        }
    }

    /**
     * Extract a PK filter spec from the pushed filters.
     * Returns a map suitable for JSON serialization into the Rust session config.
     */
    private fun extractPkFilter(): Map<String, Any>? {
        for (filter in pushedFilters) {
            when (filter) {
                is EqualTo -> {
                    if (filter.attribute() in pkColumns) {
                        return mapOf(
                            "filter_type" to "eq",
                            "values" to listOf(filter.value())
                        )
                    }
                }
                is In -> {
                    if (filter.attribute() in pkColumns) {
                        return mapOf(
                            "filter_type" to "in",
                            "values" to filter.values().toList()
                        )
                    }
                }
            }
        }
        return null
    }
}
