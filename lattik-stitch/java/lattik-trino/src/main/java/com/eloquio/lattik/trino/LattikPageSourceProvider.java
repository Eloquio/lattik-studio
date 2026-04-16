package com.eloquio.lattik.trino;

import io.trino.spi.connector.*;

import java.util.List;

public class LattikPageSourceProvider implements ConnectorPageSourceProvider {
    private final String warehouse;

    public LattikPageSourceProvider(String warehouse) {
        this.warehouse = warehouse;
    }

    @Override
    public ConnectorPageSource createPageSource(
            ConnectorTransactionHandle transaction,
            ConnectorSession session,
            ConnectorSplit split,
            ConnectorTableHandle table,
            List<ColumnHandle> columns,
            DynamicFilter dynamicFilter) {

        var lattikSplit = (LattikSplit) split;
        var lattikTable = (LattikTableHandle) table;
        var columnHandles = columns.stream()
                .map(c -> (LattikColumnHandle) c)
                .toList();

        return new LattikPageSource(lattikSplit, lattikTable, columnHandles, warehouse, dynamicFilter);
    }
}
