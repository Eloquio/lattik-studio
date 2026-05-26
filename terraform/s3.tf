# Destination bucket for everything Lattik Studio writes to S3:
#   - Firehose-delivered logger events: lattik-logger/<table>/...
#   - Generated typed SDK clients:      firehose-sdks/<table>.ts
#   - Firehose delivery errors:         lattik-logger/errors/<table>/...
#
# Versioning is on so accidental overwrites of an SDK file are recoverable.
resource "aws_s3_bucket" "firehose" {
  bucket = local.firehose_bucket_name
}

resource "aws_s3_bucket_versioning" "firehose" {
  bucket = aws_s3_bucket.firehose.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "firehose" {
  bucket = aws_s3_bucket.firehose.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "firehose" {
  bucket = aws_s3_bucket.firehose.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
