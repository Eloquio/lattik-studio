package com.eloquio.lattik.trino;

import io.trino.spi.connector.ConnectorSplit;

import java.util.Map;

/**
 * A split representing one stitch operation across loads.
 * For v1, one split per table (the NaiveStitcher handles everything in one pass).
 */
public record LattikSplit(
        String tableName,
        int manifestVersion,
        String manifestLoadId,
        String specJson,
        Map<String, String> columnToLoadId,  // column_name → load_id from the manifest
        Map<String, LattikLoadInfo> loadInfoById
) implements ConnectorSplit {
}

record LattikLoadInfo(
        String formatId,
        boolean sorted,
        boolean hasPkIndex
) {
}
