data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  firehose_bucket_name = coalesce(
    var.firehose_bucket_name,
    "lattik-studio-firehose-${local.account_id}"
  )

  # Scope the assumed-role name to the environment so production and
  # preview can co-exist in the same account with distinct ARNs.
  role_name                  = "${var.name_prefix}-${var.environment}"
  firehose_service_role_name = "${var.name_prefix}-firehose-service"

  vercel_sub = "owner:${var.vercel_team_slug}:project:${var.vercel_project_name}:environment:${var.environment}"
  vercel_aud = "https://vercel.com/${var.vercel_team_slug}"

  common_tags = {
    Project   = "lattik-studio"
    ManagedBy = "terraform"
  }
}
