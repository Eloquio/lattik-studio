package com.eloquio.lattik.trino;

import com.eloquio.lattik.stitch.LattikStitchJni;
import com.google.gson.Gson;
import io.trino.spi.Page;
import io.trino.spi.block.*;
import io.trino.spi.connector.DynamicFilter;
import io.trino.spi.connector.ConnectorPageSource;
import io.trino.spi.connector.SourcePage;
import io.trino.spi.type.BigintType;
import io.trino.spi.type.BooleanType;
import io.trino.spi.type.DoubleType;
import io.trino.spi.type.Type;
import io.trino.spi.type.VarbinaryType;
import io.trino.spi.type.VarcharType;
import org.apache.arrow.c.ArrowArray;
import org.apache.arrow.c.ArrowSchema;
import org.apache.arrow.c.CDataDictionaryProvider;
import org.apache.arrow.c.Data;
import org.apache.arrow.memory.RootAllocator;
import org.apache.arrow.vector.*;
import org.apache.arrow.vector.util.Text;

import java.util.*;
import java.util.LinkedHashMap;
import java.util.stream.Collectors;

/**
 * Reads stitched data from the Rust core via JNI and converts Arrow
 * RecordBatches to Trino Pages.
 */
public class LattikPageSource implements ConnectorPageSource {
    private final long rustSessionHandle;
    private final RootAllocator allocator;
    private final List<LattikColumnHandle> columns;
    private boolean finished = false;
    private long readBytes = 0;

    public LattikPageSource(
            LattikSplit split,
            LattikTableHandle table,
            List<LattikColumnHandle> columns,
            String warehouse,
            DynamicFilter dynamicFilter) {

        this.columns = columns;
        this.allocator = new RootAllocator();

        // Build the session config JSON (same structure as the Spark connector)
        String s3Endpoint = System.getenv("S3_ENDPOINT") != null
                ? System.getenv("S3_ENDPOINT")
                : "http://minio.minio.svc.cluster.local:9000";
        String s3Region = System.getenv("AWS_REGION") != null
                ? System.getenv("AWS_REGION") : "us-east-1";
        String s3AccessKey = System.getenv("AWS_ACCESS_KEY_ID") != null
                ? System.getenv("AWS_ACCESS_KEY_ID") : "lattik";
        String s3SecretKey = System.getenv("AWS_SECRET_ACCESS_KEY") != null
                ? System.getenv("AWS_SECRET_ACCESS_KEY") : "lattik-local";
        String bucket = warehouse.replaceFirst("^s3://", "").replaceFirst("^s3a://", "").replaceAll("/$", "");

        // Derive PK columns and column types from the spec
        Map<?, ?> spec = table.specJson() == null ? Map.of() : new Gson().fromJson(table.specJson(), Map.class);
        var pkColumns = extractPkColumns(spec);
        var columnTypes = deriveColumnTypes(spec, pkColumns);

        // Group requested columns by load ID
        var loadToColumns = new LinkedHashMap<String, List<String>>();
        for (var col : columns) {
            String loadId = split.columnToLoadId().get(col.name());
            if (loadId != null) {
                loadToColumns.computeIfAbsent(loadId, k -> new ArrayList<>()).add(col.name());
            }
        }
        // Ensure PK columns are included in each load
        for (var entry : loadToColumns.entrySet()) {
            for (String pk : pkColumns) {
                if (!entry.getValue().contains(pk)) {
                    entry.getValue().add(0, pk);
                }
            }
        }

        if (loadToColumns.isEmpty()) {
            for (String loadId : split.loadInfoById().keySet()) {
                loadToColumns.put(loadId, new ArrayList<>());
            }
        }

        // Build load specs
        var loadSpecs = loadToColumns.entrySet().stream().map(e -> Map.of(
                "load_id", (Object) e.getKey(),
                "path", "lattik/" + table.tableName() + "/loads/" + e.getKey(),
                "columns", e.getValue().stream().filter(c -> !pkColumns.contains(c)).collect(Collectors.toList()),
                "pk_columns", pkColumns,
                "format_id", split.loadInfoById().get(e.getKey()).formatId(),
                "sorted", split.loadInfoById().get(e.getKey()).sorted(),
                "has_pk_index", split.loadInfoById().get(e.getKey()).hasPkIndex()
        )).collect(Collectors.toList());

        // Build output_columns with types
        var outputColumns = columns.stream().map(c -> Map.of(
                "name", (Object) c.name(),
                "data_type", columnTypes.getOrDefault(c.name(), "string")
        )).collect(Collectors.toList());

        var pkFilter = extractPkFilter(dynamicFilter, columns, pkColumns);
        var config = new LinkedHashMap<String, Object>();
        config.put("load_specs", loadSpecs);
        config.put("pk_columns", pkColumns);
        config.put("stitcher_id", pkFilter != null ? "indexed" : "naive");
        config.put("output_columns", outputColumns);
        if (pkFilter != null) {
            config.put("pk_filter", pkFilter);
        }
        config.put("s3_config", Map.of(
                "endpoint", s3Endpoint,
                "region", s3Region,
                "bucket", bucket,
                "access_key_id", s3AccessKey,
                "secret_access_key", s3SecretKey
        ));

        String configJson = new Gson().toJson(config);
        this.rustSessionHandle = LattikStitchJni.createSession(configJson);
        if (this.rustSessionHandle == 0L) {
            throw new RuntimeException("Failed to create native stitch session for " + table.tableName());
        }
    }

    @Override
    public long getCompletedBytes() {
        return readBytes;
    }

    @Override
    public long getReadTimeNanos() {
        return 0;
    }

    @Override
    public boolean isFinished() {
        return finished;
    }

    @Override
    public SourcePage getNextSourcePage() {
        if (finished) return null;

        if (!LattikStitchJni.hasNext(rustSessionHandle)) {
            finished = true;
            return null;
        }

        // Import Arrow data via C Data Interface
        try (var arrowSchema = ArrowSchema.allocateNew(allocator);
             var arrowArray = ArrowArray.allocateNew(allocator)) {

            boolean produced = LattikStitchJni.nextBatch(
                    rustSessionHandle,
                    arrowSchema.memoryAddress(),
                    arrowArray.memoryAddress());

            if (!produced) {
                finished = true;
                return null;
            }

            // Import as VectorSchemaRoot
            try (var dictProvider = new CDataDictionaryProvider();
                 var root = Data.importVectorSchemaRoot(allocator, arrowArray, arrowSchema, dictProvider)) {

                int rowCount = root.getRowCount();
                var blocks = new Block[columns.size()];

                for (int i = 0; i < columns.size(); i++) {
                    var col = columns.get(i);
                    var vector = root.getVector(col.name());
                    blocks[i] = convertToBlock(vector, col.type(), rowCount);
                }

                readBytes += rowCount * columns.size() * 8L; // rough estimate
                return SourcePage.create(new Page(rowCount, blocks));
            }
        }
    }

    @Override
    public long getMemoryUsage() {
        return allocator.getAllocatedMemory();
    }

    @Override
    public void close() {
        LattikStitchJni.closeSession(rustSessionHandle);
        allocator.close();
    }

    /**
     * Convert an Arrow FieldVector to a Trino Block.
     */
    private Block convertToBlock(FieldVector vector, Type trinoType, int rowCount) {
        if (trinoType == BigintType.BIGINT) {
            return convertBigintBlock(vector, rowCount);
        } else if (trinoType == DoubleType.DOUBLE) {
            return convertDoubleBlock(vector, rowCount);
        } else if (trinoType == BooleanType.BOOLEAN) {
            return convertBooleanBlock(vector, rowCount);
        } else if (trinoType instanceof VarcharType) {
            return convertVarcharBlock(vector, rowCount);
        } else if (trinoType == VarbinaryType.VARBINARY) {
            return convertVarbinaryBlock(vector, rowCount);
        } else {
            // Fallback: null block
            return RunLengthEncodedBlock.create(trinoType, null, rowCount);
        }
    }

    private Block convertBigintBlock(FieldVector vector, int rowCount) {
        var builder = new LongArrayBlockBuilder(null, rowCount);
        if (vector instanceof BigIntVector bigIntVector) {
            for (int i = 0; i < rowCount; i++) {
                if (bigIntVector.isNull(i)) {
                    builder.appendNull();
                } else {
                    BigintType.BIGINT.writeLong(builder, bigIntVector.get(i));
                }
            }
        } else {
            for (int i = 0; i < rowCount; i++) {
                builder.appendNull();
            }
        }
        return builder.build();
    }

    private Block convertDoubleBlock(FieldVector vector, int rowCount) {
        var builder = new LongArrayBlockBuilder(null, rowCount);
        if (vector instanceof Float8Vector float8Vector) {
            for (int i = 0; i < rowCount; i++) {
                if (float8Vector.isNull(i)) {
                    builder.appendNull();
                } else {
                    DoubleType.DOUBLE.writeDouble(builder, float8Vector.get(i));
                }
            }
        } else {
            for (int i = 0; i < rowCount; i++) {
                builder.appendNull();
            }
        }
        return builder.build();
    }

    private Block convertVarcharBlock(FieldVector vector, int rowCount) {
        var builder = new VariableWidthBlockBuilder(null, rowCount, rowCount * 32);
        if (vector instanceof VarCharVector varCharVector) {
            for (int i = 0; i < rowCount; i++) {
                if (varCharVector.isNull(i)) {
                    builder.appendNull();
                } else {
                    var bytes = varCharVector.get(i);
                    VarcharType.VARCHAR.writeSlice(builder, io.airlift.slice.Slices.wrappedBuffer(bytes));
                }
            }
        } else {
            for (int i = 0; i < rowCount; i++) {
                builder.appendNull();
            }
        }
        return builder.build();
    }

    private Block convertBooleanBlock(FieldVector vector, int rowCount) {
        var builder = new ByteArrayBlockBuilder(null, rowCount);
        if (vector instanceof BitVector bitVector) {
            for (int i = 0; i < rowCount; i++) {
                if (bitVector.isNull(i)) {
                    builder.appendNull();
                } else {
                    BooleanType.BOOLEAN.writeBoolean(builder, bitVector.get(i) != 0);
                }
            }
        } else {
            for (int i = 0; i < rowCount; i++) {
                builder.appendNull();
            }
        }
        return builder.build();
    }

    private Block convertVarbinaryBlock(FieldVector vector, int rowCount) {
        var builder = new VariableWidthBlockBuilder(null, rowCount, rowCount * 32);
        if (vector instanceof VarBinaryVector varBinaryVector) {
            for (int i = 0; i < rowCount; i++) {
                if (varBinaryVector.isNull(i)) {
                    builder.appendNull();
                } else {
                    VarbinaryType.VARBINARY.writeSlice(builder, io.airlift.slice.Slices.wrappedBuffer(varBinaryVector.get(i)));
                }
            }
        } else {
            for (int i = 0; i < rowCount; i++) {
                builder.appendNull();
            }
        }
        return builder.build();
    }

    @SuppressWarnings("unchecked")
    private static List<String> extractPkColumns(Map<?, ?> spec) {
        var primaryKey = (List<?>) spec.get("primary_key");
        if (primaryKey == null) return List.of();
        return primaryKey.stream()
                .map(pk -> (String) ((Map<?, ?>) pk).get("column"))
                .filter(Objects::nonNull)
                .collect(Collectors.toList());
    }

    private static Map<String, String> deriveColumnTypes(Map<?, ?> spec, List<String> pkColumns) {
        var types = new LinkedHashMap<String, String>();
        for (String pk : pkColumns) {
            types.put(pk, "int64");
        }
        var families = (List<?>) spec.get("column_families");
        if (families != null) {
            for (var family : families) {
                var familyMap = (Map<?, ?>) family;
                var cols = (List<?>) familyMap.get("columns");
                if (cols != null) {
                    for (var col : cols) {
                        var colMap = (Map<?, ?>) col;
                        var name = (String) colMap.get("name");
                        var strategy = (String) colMap.get("strategy");
                        types.put(name, switch (strategy != null ? strategy : "") {
                            case "lifetime_window" -> {
                                var aggObj = colMap.get("agg");
                                var agg = (aggObj instanceof String s ? s : "").toLowerCase();
                                yield agg.contains("count") ? "int64" : "double";
                            }
                            case "prepend_list" -> "string";
                            case "bitmap_activity" -> "binary";
                            default -> "string";
                        });
                    }
                }
            }
        }
        return types;
    }

    private static Map<String, Object> extractPkFilter(
            DynamicFilter dynamicFilter,
            List<LattikColumnHandle> columns,
            List<String> pkColumns) {
        if (dynamicFilter == null || pkColumns.isEmpty()) {
            return null;
        }

        var domains = dynamicFilter.getCurrentPredicate().getDomains();
        if (domains.isEmpty()) {
            return null;
        }

        for (var entry : domains.get().entrySet()) {
            if (!(entry.getKey() instanceof LattikColumnHandle handle)) {
                continue;
            }
            if (!pkColumns.contains(handle.name())) {
                continue;
            }
            var domain = entry.getValue();
            if (domain == null || domain.isNullAllowed()) {
                continue;
            }

            var values = domain.getValues();
            if (values.isDiscreteSet()) {
                List<Object> discreteValues = new ArrayList<>();
                values.getDiscreteSet().forEach(value -> discreteValues.add(normalizePkValue(value)));
                if (discreteValues.size() == 1) {
                    return Map.of("filter_type", "eq", "values", discreteValues);
                }
                if (!discreteValues.isEmpty()) {
                    return Map.of("filter_type", "in", "values", discreteValues);
                }
            }

            var ranges = values.getRanges().getOrderedRanges();
            if (ranges.size() == 1) {
                var range = ranges.get(0);
                if (!range.isLowUnbounded() && !range.isHighUnbounded()
                        && range.isLowInclusive() && range.isHighInclusive()) {
                    return Map.of(
                            "filter_type", "range",
                            "min", normalizePkValue(range.getLowBoundedValue()),
                            "max", normalizePkValue(range.getHighBoundedValue())
                    );
                }
            }
        }

        return null;
    }

    private static Object normalizePkValue(Object value) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof io.airlift.slice.Slice slice) {
            return slice.toStringUtf8();
        }
        return value;
    }
}
