package com.eloquio.lattik.trino;

import io.trino.spi.connector.ConnectorTableHandle;

public record LattikTableHandle(
        String tableName,
        int manifestVersion,
        String manifestLoadId,
        String specJson
) implements ConnectorTableHandle {
}
