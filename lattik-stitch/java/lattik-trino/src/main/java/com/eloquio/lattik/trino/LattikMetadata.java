package com.eloquio.lattik.trino;

import com.google.gson.Gson;
import io.trino.spi.connector.*;
import io.trino.spi.type.BigintType;
import io.trino.spi.type.BooleanType;
import io.trino.spi.type.DoubleType;
import io.trino.spi.type.Type;
import io.trino.spi.type.VarbinaryType;
import io.trino.spi.type.VarcharType;

import java.sql.DriverManager;
import java.util.*;

/**
 * Provides table listing and column schema for Lattik Tables.
 * Reads table specs from the definitions table in Postgres.
 */
public class LattikMetadata implements ConnectorMetadata {
    private final String warehouse;
    private final String jdbcUrl;
    private final int maxStitchLoads;

    public LattikMetadata(String warehouse, String jdbcUrl, int maxStitchLoads) {
        this.warehouse = warehouse;
        this.jdbcUrl = jdbcUrl;
        this.maxStitchLoads = maxStitchLoads;
    }

    @Override
    public List<String> listSchemaNames(ConnectorSession session) {
        return List.of("default");
    }

    @Override
    public List<SchemaTableName> listTables(ConnectorSession session, Optional<String> schemaName) {
        var tables = new ArrayList<SchemaTableName>();
        try {
            Class.forName("org.postgresql.Driver");
        } catch (ClassNotFoundException e) {
            throw new RuntimeException("PostgreSQL JDBC driver not found in plugin classloader", e);
        }
        try (var conn = DriverManager.getConnection(jdbcUrl)) {
            var stmt = conn.prepareStatement(
                    "SELECT DISTINCT table_name FROM lattik_table_commit");
            var rs = stmt.executeQuery();
            while (rs.next()) {
                tables.add(new SchemaTableName("default", rs.getString("table_name")));
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to list Lattik tables", e);
        }
        return tables;
    }

    @Override
    public ConnectorTableHandle getTableHandle(ConnectorSession session, SchemaTableName tableName, Optional<ConnectorTableVersion> startVersion, Optional<ConnectorTableVersion> endVersion) {
        String name = tableName.getTableName();
        try (var conn = DriverManager.getConnection(jdbcUrl)) {
            var stmt = conn.prepareStatement(
                    "SELECT manifest_version, manifest_load_id FROM lattik_table_commit " +
                    "WHERE table_name = ? ORDER BY manifest_version DESC LIMIT 1");
            stmt.setString(1, name);
            var rs = stmt.executeQuery();
            if (!rs.next()) return null;

            int manifestVersion = rs.getInt("manifest_version");
            String manifestLoadId = rs.getString("manifest_load_id");

            // Read spec
            var specStmt = conn.prepareStatement(
                    "SELECT spec FROM definition WHERE kind = 'lattik_table' AND name = ? " +
                    "ORDER BY version DESC LIMIT 1");
            specStmt.setString(1, name);
            var specRs = specStmt.executeQuery();
            String specJson = specRs.next() ? specRs.getString("spec") : null;

            return new LattikTableHandle(name, manifestVersion, manifestLoadId, specJson);
        } catch (Exception e) {
            throw new RuntimeException("Failed to get table handle for " + name, e);
        }
    }

    @Override
    public ConnectorTableMetadata getTableMetadata(ConnectorSession session, ConnectorTableHandle table) {
        var handle = (LattikTableHandle) table;
        var columns = buildColumns(handle);
        return new ConnectorTableMetadata(
                new SchemaTableName("default", handle.tableName()),
                columns
        );
    }

    @Override
    public Map<String, ColumnHandle> getColumnHandles(ConnectorSession session, ConnectorTableHandle tableHandle) {
        var handle = (LattikTableHandle) tableHandle;
        var columns = buildColumns(handle);
        var result = new LinkedHashMap<String, ColumnHandle>();
        for (int i = 0; i < columns.size(); i++) {
            var col = columns.get(i);
            result.put(col.getName(), new LattikColumnHandle(col.getName(), col.getType(), i));
        }
        return result;
    }

    @Override
    public ColumnMetadata getColumnMetadata(ConnectorSession session, ConnectorTableHandle tableHandle, ColumnHandle columnHandle) {
        var col = (LattikColumnHandle) columnHandle;
        return new ColumnMetadata(col.name(), col.type());
    }

    private List<ColumnMetadata> buildColumns(LattikTableHandle handle) {
        var columns = new ArrayList<ColumnMetadata>();

        if (handle.specJson() != null) {
            var spec = new Gson().fromJson(handle.specJson(), Map.class);

            // PK columns
            var primaryKey = (List<?>) spec.get("primary_key");
            if (primaryKey != null) {
                for (var pk : primaryKey) {
                    var pkMap = (Map<?, ?>) pk;
                    var colName = (String) pkMap.get("column");
                    columns.add(new ColumnMetadata(colName, BigintType.BIGINT));
                }
            }

            // Payload columns from families
            var families = (List<?>) spec.get("column_families");
            if (families != null) {
                for (var family : families) {
                    var familyMap = (Map<?, ?>) family;
                    var familyCols = (List<?>) familyMap.get("columns");
                    if (familyCols != null) {
                        for (var col : familyCols) {
                            var colMap = (Map<?, ?>) col;
                            var name = (String) colMap.get("name");
                            var strategy = (String) colMap.get("strategy");
                            var type = inferType(strategy, colMap);
                            columns.add(new ColumnMetadata(name, type));
                        }
                    }
                }
            }
        }

        return columns;
    }

    private Type inferType(String strategy, Map<?, ?> colMap) {
        if (strategy == null) return VarcharType.VARCHAR;
        return switch (strategy) {
            case "lifetime_window" -> {
                var aggObj = colMap.get("agg");
                var agg = (aggObj instanceof String s ? s : "").toLowerCase();
                if (agg.contains("count")) yield BigintType.BIGINT;
                yield DoubleType.DOUBLE;
            }
            case "prepend_list" -> VarcharType.VARCHAR;
            case "bitmap_activity" -> VarbinaryType.VARBINARY;
            default -> VarcharType.VARCHAR;
        };
    }
}
