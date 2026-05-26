output "lattik_studio_role_arn" {
  description = "Set AWS_ROLE_ARN in the Vercel project (production environment) to this value. Lattik Studio assumes this role at runtime via OIDC."
  value       = aws_iam_role.lattik_studio.arn
}

output "firehose_service_role_arn" {
  description = "Set FIREHOSE_ROLE_ARN in the Vercel project to this value. Lattik Studio passes this when calling CreateDeliveryStream so Firehose can write to S3."
  value       = aws_iam_role.firehose_service.arn
}

output "firehose_bucket_arn" {
  description = "Set FIREHOSE_S3_BUCKET_ARN in the Vercel project to this value."
  value       = aws_s3_bucket.firehose.arn
}

output "firehose_bucket_name" {
  description = "Set FIREHOSE_SDK_BUCKET in the Vercel project to this value (the SDK generator writes to `s3://<this>/firehose-sdks/`)."
  value       = aws_s3_bucket.firehose.bucket
}

output "vercel_oidc_provider_arn" {
  description = "ARN of the Vercel OIDC identity provider in IAM. Referenced by the trust policy."
  value       = aws_iam_openid_connect_provider.vercel.arn
}
