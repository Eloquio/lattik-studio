package com.eloquio.lattik.spark

import org.apache.spark.sql.connector.catalog.*
import org.apache.spark.sql.connector.expressions.Transform
import org.apache.spark.sql.types.StructType
import org.apache.spark.sql.util.CaseInsensitiveStringMap
import java.sql.DriverManager
import java.util.*

/**
 * Spark V2 CatalogPlugin for Lattik Tables.
 *
 * Registered via:
 *   spark.sql.catalog.lattik = com.eloquio.lattik.spark.LattikCatalog
 *   spark.sql.catalog.lattik.warehouse = s3://warehouse
 *   spark.sql.catalog.lattik.jdbc-url = jdbc:postgresql://localhost:5432/lattik_studio
 */
class LattikCatalog : TableCatalog {
    private lateinit var catalogName: String
    private lateinit var warehouse: String
    private lateinit var jdbcUrl: String
    private var maxStitchLoads: Int = 3

    override fun initialize(name: String, options: CaseInsensitiveStringMap) {
        catalogName = name
        warehouse = options.getOrDefault("warehouse", "s3://warehouse")
        jdbcUrl = options.getOrDefault("jdbc-url", "jdbc:postgresql://localhost:5432/lattik_studio")
        maxStitchLoads = options.getOrDefault("max-stitch-loads", "3").toInt()
    }

    override fun name(): String = catalogName

    override fun listTables(namespace: Array<String>): Array<Identifier> {
        val conn = DriverManager.getConnection(jdbcUrl)
        conn.use {
            val stmt = it.prepareStatement(
                "SELECT DISTINCT table_name FROM lattik_table_commit"
            )
            val rs = stmt.executeQuery()
            val tables = mutableListOf<Identifier>()
            while (rs.next()) {
                tables.add(Identifier.of(namespace, rs.getString("table_name")))
            }
            return tables.toTypedArray()
        }
    }

    override fun loadTable(ident: Identifier): Table {
        val tableName = ident.name()
        val conn = DriverManager.getConnection(jdbcUrl)
        conn.use {
            // Read latest manifest version
            val commitStmt = it.prepareStatement(
                """SELECT manifest_version, manifest_load_id
                   FROM lattik_table_commit
                   WHERE table_name = ?
                   ORDER BY manifest_version DESC LIMIT 1"""
            )
            commitStmt.setString(1, tableName)
            val commitRs = commitStmt.executeQuery()

            if (!commitRs.next()) {
                throw RuntimeException("Table not found: ${ident.name()}")
            }

            val manifestVersion = commitRs.getInt("manifest_version")
            val manifestLoadId = commitRs.getString("manifest_load_id")

            // Read the table spec from the definitions table to get PK columns
            val specStmt = it.prepareStatement(
                """SELECT spec FROM definition
                   WHERE kind = 'lattik_table' AND name = ?
                   ORDER BY version DESC LIMIT 1"""
            )
            specStmt.setString(1, tableName)
            val specRs = specStmt.executeQuery()
            val specJson = if (specRs.next()) specRs.getString("spec") else null

            return LattikStitchedTable(
                tableName = tableName,
                manifestVersion = manifestVersion,
                manifestLoadId = manifestLoadId,
                warehouse = warehouse,
                jdbcUrl = jdbcUrl,
                maxStitchLoads = maxStitchLoads,
                specJson = specJson,
            )
        }
    }

    override fun tableExists(ident: Identifier): Boolean {
        return try {
            loadTable(ident)
            true
        } catch (_: RuntimeException) {
            false
        }
    }

    // Write operations — not supported (writes go through the batch driver)
    override fun createTable(ident: Identifier, schema: StructType, partitions: Array<Transform>, properties: MutableMap<String, String>): Table =
        throw UnsupportedOperationException("Use Lattik Studio to create tables")
    override fun alterTable(ident: Identifier, vararg changes: TableChange): Table =
        throw UnsupportedOperationException("Use Lattik Studio to alter tables")
    override fun dropTable(ident: Identifier): Boolean =
        throw UnsupportedOperationException("Use Lattik Studio to drop tables")
    override fun renameTable(oldIdent: Identifier, newIdent: Identifier) =
        throw UnsupportedOperationException("Use Lattik Studio to rename tables")
}
