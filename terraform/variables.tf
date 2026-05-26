variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "vercel_team_slug" {
  description = "Vercel team slug (the team identifier in your Vercel URL, e.g. 'eloquio')."
  type        = string
}

variable "vercel_project_name" {
  description = "Vercel project name (slug) the OIDC `sub` claim will reference."
  type        = string
  default     = "lattik-studio"
}

variable "environment" {
  description = "Vercel environment to scope this role to. Each environment gets its own role — re-run terraform with a different value (and workspace/state) to provision additional ones."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "preview", "development"], var.environment)
    error_message = "environment must be one of: production, preview, development."
  }
}

variable "name_prefix" {
  description = "Prefix for IAM role names and other named resources."
  type        = string
  default     = "lattik-studio"
}

variable "firehose_bucket_name" {
  description = "S3 bucket for Firehose-delivered events + generated SDK files. Must be globally unique. Defaults to lattik-studio-firehose-<account-id>."
  type        = string
  default     = null
}
