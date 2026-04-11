import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type _Object,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "lattik",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "lattik-local",
  },
  forcePathStyle: true,
});

export async function putObject(
  bucket: string,
  key: string,
  body: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "text/yaml",
    }),
  );
}

export async function getObject(
  bucket: string,
  key: string,
): Promise<string> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = await result.Body?.transformToString();
  if (body === undefined) {
    throw new Error(`s3://${bucket}/${key}: empty body`);
  }
  return body;
}

export async function deleteObject(
  bucket: string,
  key: string,
): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Batch-delete up to 1000 keys at a time. Returns the number of keys deleted.
 * Chunks internally so callers can pass any size list.
 */
export async function deleteObjects(
  bucket: string,
  keys: string[],
): Promise<number> {
  if (keys.length === 0) return 0;
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })) },
      }),
    );
    deleted += chunk.length;
  }
  return deleted;
}

export async function listObjects(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of result.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

/**
 * List objects with their metadata (key + lastModified + size). Used by the
 * GC job to respect a minimum-age grace period on orphaned load files.
 */
export async function listObjectsDetailed(
  bucket: string,
  prefix: string,
): Promise<_Object[]> {
  const objects: _Object[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of result.Contents ?? []) {
      objects.push(obj);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return objects;
}
