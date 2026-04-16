package com.eloquio.lattik.trino;

import io.trino.spi.Plugin;
import io.trino.spi.connector.ConnectorFactory;

import java.util.List;

/**
 * Trino plugin entry point for the Lattik connector.
 * Registered via META-INF/services/io.trino.spi.Plugin.
 */
public class LattikPlugin implements Plugin {
    @Override
    public Iterable<ConnectorFactory> getConnectorFactories() {
        return List.of(new LattikConnectorFactory());
    }
}
