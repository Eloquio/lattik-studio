# ---------------------------------------------------------------------------
# Lattik Studio role — assumed by the Next.js app via Vercel OIDC.
#
# Trust is per-environment: production deployments can't accidentally
# assume the preview role and vice-versa. To add another environment, run
# terraform again with -var environment=preview against a separate state
# file (or workspace).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "lattik_studio_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.vercel.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "oidc.vercel.com/${var.vercel_team_slug}:aud"
      values   = [local.vercel_aud]
    }

    condition {
      test     = "StringEquals"
      variable = "oidc.vercel.com/${var.vercel_team_slug}:sub"
      values   = [local.vercel_sub]
    }
  }
}

resource "aws_iam_role" "lattik_studio" {
  name               = local.role_name
  description        = "Assumed by Lattik Studio on Vercel via OIDC. Environment: ${var.environment}."
  assume_role_policy = data.aws_iam_policy_document.lattik_studio_trust.json
}

data "aws_iam_policy_document" "lattik_studio_perms" {
  # Create + describe Firehose delivery streams for logger tables.
  # Restricted to the `lattik-` name prefix so a misconfigured caller
  # can't touch unrelated streams in the same account.
  statement {
    sid    = "ManageLoggerDeliveryStreams"
    effect = "Allow"
    actions = [
      "firehose:CreateDeliveryStream",
      "firehose:DescribeDeliveryStream",
      "firehose:UpdateDestination",
      "firehose:TagDeliveryStream",
    ]
    resources = [
      "arn:aws:firehose:${var.aws_region}:${local.account_id}:deliverystream/lattik-*",
    ]
  }

  # CreateDeliveryStream needs PassRole on the Firehose service role so
  # Firehose can write to the destination bucket on the app's behalf.
  # The PassedToService condition prevents this from being usable to hand
  # the role to any other service.
  statement {
    sid       = "PassFirehoseServiceRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.firehose_service.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["firehose.amazonaws.com"]
    }
  }

  # Write the generated TypeScript SDK file for each logger table.
  # Scoped to the firehose-sdks/ prefix so the app can't write into the
  # Firehose output prefix and pollute the data lake.
  statement {
    sid       = "PublishGeneratedSdkClients"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.firehose.arn}/firehose-sdks/*"]
  }
}

resource "aws_iam_role_policy" "lattik_studio" {
  name   = "${local.role_name}-inline"
  role   = aws_iam_role.lattik_studio.id
  policy = data.aws_iam_policy_document.lattik_studio_perms.json
}

# ---------------------------------------------------------------------------
# Firehose service role — assumed by the Firehose service itself when
# delivering events to S3. Lattik Studio does NOT assume this role; it
# only passes the ARN when calling CreateDeliveryStream.
#
# Shared across environments because Firehose's behavior is identical
# everywhere; environment isolation lives on the *caller's* side
# (lattik_studio role) and in stream names (which are per-table).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "firehose_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "firehose_service" {
  name               = local.firehose_service_role_name
  description        = "Assumed by Amazon Data Firehose to write logger events to S3."
  assume_role_policy = data.aws_iam_policy_document.firehose_trust.json
}

data "aws_iam_policy_document" "firehose_perms" {
  statement {
    sid    = "WriteLoggerEventsToS3"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.firehose.arn,
      "${aws_s3_bucket.firehose.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "firehose_service" {
  name   = "${local.firehose_service_role_name}-inline"
  role   = aws_iam_role.firehose_service.id
  policy = data.aws_iam_policy_document.firehose_perms.json
}
