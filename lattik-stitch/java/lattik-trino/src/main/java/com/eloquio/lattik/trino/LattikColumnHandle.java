package com.eloquio.lattik.trino;

import io.trino.spi.connector.ColumnHandle;
import io.trino.spi.type.Type;

public record LattikColumnHandle(
        String name,
        Type type,
        int ordinal
) implements ColumnHandle {
}
