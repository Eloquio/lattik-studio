# State is stored in S3 with native lockfile support (Terraform 1.10+).
# DynamoDB is no longer required — `use_lockfile = true` performs locking
# via S3 conditional writes (`If-None-Match` on a `.tflock` object next to
# the state file).
#
# The bucket itself must exist BEFORE `terraform init` — see README.md for
# the one-time bootstrap commands. Backend config cannot reference
# variables, so the values below are hard-coded; override with
# `-backend-config=...` at init time if you fork this for another account.
terraform {
  backend "s3" {
    bucket       = "lattik-studio-tfstate"
    key          = "infrastructure/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
