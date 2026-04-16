package com.eloquio.lattik.trino;

import io.trino.spi.connector.Connector;
import io.trino.spi.connector.ConnectorMetadata;
import io.trino.spi.connector.ConnectorPageSourceProvider;
import io.trino.spi.connector.ConnectorSession;
import io.trino.spi.connector.ConnectorSplitManager;
import io.trino.spi.connector.ConnectorTransactionHandle;
import io.trino.spi.transaction.IsolationLevel;

/**
 * Lattik connector for Trino. Provides read-only access to stitched Lattik Tables.
 */
public class LattikConnector implements Connector {
    private final String warehouse;
    private final String jdbcUrl;
    private final int maxStitchLoads;

    public LattikConnector(String warehouse, String jdbcUrl, int maxStitchLoads) {
        this.warehouse = warehouse;
        this.jdbcUrl = jdbcUrl;
        this.maxStitchLoads = maxStitchLoads;
    }

    @Override
    public ConnectorTransactionHandle beginTransaction(IsolationLevel isolationLevel, boolean readOnly, boolean autoCommit) {
        return LattikTransactionHandle.INSTANCE;
    }

    @Override
    public ConnectorMetadata getMetadata(ConnectorSession session, ConnectorTransactionHandle transaction) {
        return new LattikMetadata(warehouse, jdbcUrl, maxStitchLoads);
    }

    @Override
    public ConnectorSplitManager getSplitManager() {
        return new LattikSplitManager(warehouse, jdbcUrl);
    }

    @Override
    public ConnectorPageSourceProvider getPageSourceProvider() {
        return new LattikPageSourceProvider(warehouse);
    }

    @Override
    public void shutdown() {
        // nothing to clean up
    }
}
