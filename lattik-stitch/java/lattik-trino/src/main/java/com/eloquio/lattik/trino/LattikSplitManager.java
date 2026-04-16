package com.eloquio.lattik.trino;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import io.trino.spi.connector.*;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;

import java.net.URI;
import java.util.List;
import java.util.Map;

/**
 * Plans splits for a Lattik Table read.
 * Fetches the manifest from S3, creates one split per table.
 */
public class LattikSplitManager implements ConnectorSplitManager {
    private final String warehouse;
    private final String jdbcUrl;

    public LattikSplitManager(String warehouse, String jdbcUrl) {
        this.warehouse = warehouse;
        this.jdbcUrl = jdbcUrl;
    }

    @Override
    public ConnectorSplitSource getSplits(
            ConnectorTransactionHandle transaction,
            ConnectorSession session,
            ConnectorTableHandle table,
            DynamicFilter dynamicFilter,
            Constraint constraint) {

        var handle = (LattikTableHandle) table;

        // Fetch manifest from S3
        var manifest = fetchManifest(handle);

        var split = new LattikSplit(
                handle.tableName(),
                handle.manifestVersion(),
                handle.manifestLoadId(),
                handle.specJson(),
                manifest.columns(),
                fetchLoadInfo(handle, manifest)
        );

        return new FixedSplitSource(List.of(split));
    }

    private ManifestData fetchManifest(LattikTableHandle handle) {
        String s3Endpoint = System.getenv("S3_ENDPOINT") != null
                ? System.getenv("S3_ENDPOINT")
                : "http://minio.minio.svc.cluster.local:9000";
        String accessKey = System.getenv("AWS_ACCESS_KEY_ID") != null
                ? System.getenv("AWS_ACCESS_KEY_ID") : "lattik";
        String secretKey = System.getenv("AWS_SECRET_ACCESS_KEY") != null
                ? System.getenv("AWS_SECRET_ACCESS_KEY") : "lattik-local";
        String region = System.getenv("AWS_REGION") != null
                ? System.getenv("AWS_REGION") : "us-east-1";

        String bucket = warehouse.replaceFirst("^s3://", "").replaceFirst("^s3a://", "").replaceAll("/$", "");
        String key = String.format("lattik/%s/manifests/v%04d_%s.json",
                handle.tableName(), handle.manifestVersion(), handle.manifestLoadId());

        try (var s3 = S3Client.builder()
                .endpointOverride(URI.create(s3Endpoint))
                .region(Region.of(region))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(accessKey, secretKey)))
                .forcePathStyle(true)
                .build()) {

            var response = s3.getObject(GetObjectRequest.builder()
                    .bucket(bucket).key(key).build());
            try {
                var body = new String(response.readAllBytes());
                return new Gson().fromJson(body, ManifestData.class);
            } catch (java.io.IOException e) {
                throw new RuntimeException("Failed to read manifest from S3: " + key, e);
            }
        }
    }

    private Map<String, LattikLoadInfo> fetchLoadInfo(LattikTableHandle handle, ManifestData manifest) {
        String s3Endpoint = System.getenv("S3_ENDPOINT") != null
                ? System.getenv("S3_ENDPOINT")
                : "http://minio.minio.svc.cluster.local:9000";
        String accessKey = System.getenv("AWS_ACCESS_KEY_ID") != null
                ? System.getenv("AWS_ACCESS_KEY_ID") : "lattik";
        String secretKey = System.getenv("AWS_SECRET_ACCESS_KEY") != null
                ? System.getenv("AWS_SECRET_ACCESS_KEY") : "lattik-local";
        String region = System.getenv("AWS_REGION") != null
                ? System.getenv("AWS_REGION") : "us-east-1";

        String bucket = warehouse.replaceFirst("^s3://", "").replaceFirst("^s3a://", "").replaceAll("/$", "");
        try (var s3 = S3Client.builder()
                .endpointOverride(URI.create(s3Endpoint))
                .region(Region.of(region))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(accessKey, secretKey)))
                .forcePathStyle(true)
                .build()) {

            var result = new java.util.LinkedHashMap<String, LattikLoadInfo>();
            for (String loadId : manifest.columns().values().stream().distinct().toList()) {
                String key = String.format("lattik/%s/loads/%s/load.json", handle.tableName(), loadId);
                var response = s3.getObject(GetObjectRequest.builder()
                        .bucket(bucket).key(key).build());
                try {
                    var body = new String(response.readAllBytes());
                    var load = new Gson().fromJson(body, LoadData.class);
                    result.put(loadId, new LattikLoadInfo(load.format(), load.sorted(), load.has_pk_index()));
                } catch (java.io.IOException e) {
                    throw new RuntimeException("Failed to read load metadata from S3: " + key, e);
                }
            }
            return result;
        }
    }

    private record ManifestData(int version, Map<String, String> columns) {}
    private record LoadData(String format, boolean sorted, boolean has_pk_index) {}
}
