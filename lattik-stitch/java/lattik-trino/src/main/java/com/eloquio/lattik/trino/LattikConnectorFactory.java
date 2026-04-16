package com.eloquio.lattik.trino;

import io.trino.spi.connector.Connector;
import io.trino.spi.connector.ConnectorContext;
import io.trino.spi.connector.ConnectorFactory;

import java.util.Map;

/**
 * Creates LattikConnector instances.
 *
 * Configured in Trino's catalog properties file:
 *   connector.name=lattik
 *   warehouse=s3://warehouse
 *   jdbc-url=jdbc:postgresql://postgres:5432/lattik_studio?user=lattik&password=lattik-local
 */
public class LattikConnectorFactory implements ConnectorFactory {
    @Override
    public String getName() {
        return "lattik";
    }

    @Override
    public Connector create(String catalogName, Map<String, String> config, ConnectorContext context) {
        String warehouse = config.getOrDefault("warehouse", "s3://warehouse");
        String jdbcUrl = config.getOrDefault("jdbc-url",
                "jdbc:postgresql://localhost:5432/lattik_studio");
        int maxStitchLoads = Integer.parseInt(
                config.getOrDefault("max-stitch-loads", "3"));

        return new LattikConnector(warehouse, jdbcUrl, maxStitchLoads);
    }
}
