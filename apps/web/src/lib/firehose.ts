import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  type CreateDeliveryStreamCommandInput,
} from "@aws-sdk/client-firehose";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const AWS_ROLE_ARN = process.env.AWS_ROLE_ARN;
const FIREHOSE_ROLE_ARN = process.env.FIREHOSE_ROLE_ARN;
const FIREHOSE_S3_BUCKET_ARN = process.env.FIREHOSE_S3_BUCKET_ARN;
const FIREHOSE_S3_PREFIX = process.env.FIREHOSE_S3_PREFIX ?? "lattik-logger/";
const FIREHOSE_ENABLED = process.env.FIREHOSE_ENABLED === "true";

let firehoseClient: FirehoseClient | null = null;
function getFirehose(): FirehoseClient {
  if (firehoseClient) return firehoseClient;
  firehoseClient = new FirehoseClient({
    region: AWS_REGION,
    // On Vercel: assume the Lattik Studio IAM role via OIDC — no long-lived
    // keys needed. Locally (no AWS_ROLE_ARN) the SDK uses its default chain
    // (env vars, ~/.aws/credentials, etc.), which only matters if a
    // developer explicitly sets FIREHOSE_ENABLED to hit real AWS from their
    // laptop. Otherwise FIREHOSE_ENABLED is false and we never call STS.
    credentials: AWS_ROLE_ARN
      ? awsCredentialsProvider({ roleArn: AWS_ROLE_ARN })
      : undefined,
  });
  return firehoseClient;
}

/**
 * Firehose stream names allow alphanumerics, hyphens, underscores, and
 * periods. Logger Table names use dots as namespace separators
 * (e.g. "events.click_events"); keep them — they're legal — and just
 * prefix so streams from this app are easy to spot in the AWS console.
 */
export function firehoseStreamName(tableName: string): string {
  return `lattik-${tableName}`;
}

export function firehoseS3Prefix(tableName: string): string {
  return `${FIREHOSE_S3_PREFIX}${tableName}/`;
}

export interface CreateLoggerDeliveryStreamResult {
  streamName: string;
  s3Prefix: string;
  /** True if the stream already existed and the call was a no-op. */
  alreadyExisted: boolean;
  /** True if FIREHOSE_ENABLED is not set — call was skipped. */
  skipped: boolean;
}

/**
 * Creates a Direct-PUT Firehose delivery stream that writes the table's
 * events to S3 under a per-table prefix. Idempotent — if a stream with the
 * same name already exists, returns `alreadyExisted: true` instead of
 * raising.
 *
 * Gated on FIREHOSE_ENABLED so local dev (which has no real AWS Firehose)
 * can still walk the workflow end-to-end. When skipped, the result records
 * the deterministic names that *would* be used so the SDK generator can
 * still emit a working client for prod.
 */
export async function createLoggerDeliveryStream(
  tableName: string,
): Promise<CreateLoggerDeliveryStreamResult> {
  const streamName = firehoseStreamName(tableName);
  const s3Prefix = firehoseS3Prefix(tableName);

  if (!FIREHOSE_ENABLED) {
    return { streamName, s3Prefix, alreadyExisted: false, skipped: true };
  }
  if (!FIREHOSE_ROLE_ARN || !FIREHOSE_S3_BUCKET_ARN) {
    throw new Error(
      "FIREHOSE_ENABLED is true but FIREHOSE_ROLE_ARN and FIREHOSE_S3_BUCKET_ARN must also be set",
    );
  }

  const input: CreateDeliveryStreamCommandInput = {
    DeliveryStreamName: streamName,
    DeliveryStreamType: "DirectPut",
    ExtendedS3DestinationConfiguration: {
      RoleARN: FIREHOSE_ROLE_ARN,
      BucketARN: FIREHOSE_S3_BUCKET_ARN,
      Prefix: s3Prefix,
      ErrorOutputPrefix: `${FIREHOSE_S3_PREFIX}errors/${tableName}/`,
      BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
      CompressionFormat: "GZIP",
    },
  };

  try {
    await getFirehose().send(new CreateDeliveryStreamCommand(input));
    return { streamName, s3Prefix, alreadyExisted: false, skipped: false };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "ResourceInUseException") {
      return { streamName, s3Prefix, alreadyExisted: true, skipped: false };
    }
    throw err;
  }
}
