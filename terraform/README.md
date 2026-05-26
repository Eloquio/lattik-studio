# Lattik Studio — AWS infrastructure

Terraform for the static AWS resources Lattik Studio depends on. **Dynamic
resources** (per-table Firehose delivery streams, per-table generated SDK
files) are created by the app at PR-merge time and are **not** in here —
keeping them out of state means adding a logger table is a normal app
operation, not a terraform run.

## What this provisions

- `aws_iam_openid_connect_provider.vercel` — federation trust for
  Vercel-hosted Lattik Studio deployments
- `aws_iam_role.lattik_studio` — the role Lattik Studio assumes at
  runtime, scoped to a single Vercel `environment` (default: `production`)
- `aws_iam_role.firehose_service` — the role Amazon Data Firehose itself
  assumes to write events to S3
- `aws_s3_bucket.firehose` — destination bucket for logger events
  (`lattik-logger/<table>/…`) and generated SDK files
  (`firehose-sdks/<table>.ts`)

## Prerequisites

- Terraform `>= 1.10` (for native S3 state locking; older versions need
  DynamoDB and this config won't work)
- AWS CLI configured with an admin-like profile for the bootstrap step
- A Vercel team and project already created (you need the team slug)

## One-time bootstrap

The state bucket has to exist before `terraform init` can use it as a
backend. Run these once per AWS account, by hand:

```bash
# Bucket for terraform state. The name is hard-coded in backend.tf — if
# you fork this for another account, change both places.
aws s3api create-bucket \
  --bucket lattik-studio-tfstate \
  --region us-east-1

# Versioning is REQUIRED for native S3 state locking to work safely.
aws s3api put-bucket-versioning \
  --bucket lattik-studio-tfstate \
  --versioning-configuration Status=Enabled

# Default encryption.
aws s3api put-bucket-encryption \
  --bucket lattik-studio-tfstate \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Block all public access. Note: subcommand is `put-public-access-block`,
# NOT `put-bucket-public-access-block` — AWS is inconsistent here.
aws s3api put-public-access-block \
  --bucket lattik-studio-tfstate \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
```

No DynamoDB table is needed — `use_lockfile = true` in `backend.tf` makes
Terraform use S3's `If-None-Match` conditional write to manage a
`*.tflock` object next to the state file. This was introduced in
Terraform 1.10 and is the recommended approach as of 1.11+.

## Apply

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars and set vercel_team_slug.

terraform init
terraform plan
terraform apply
```

The outputs include four ARNs/names you need to paste into the Vercel
project's environment variables:

| Terraform output             | Vercel env var          |
|------------------------------|-------------------------|
| `lattik_studio_role_arn`     | `AWS_ROLE_ARN`          |
| `firehose_service_role_arn`  | `FIREHOSE_ROLE_ARN`     |
| `firehose_bucket_arn`        | `FIREHOSE_S3_BUCKET_ARN`|
| `firehose_bucket_name`       | `FIREHOSE_SDK_BUCKET`   |

Also set `FIREHOSE_ENABLED=true` and `AWS_REGION` in the same Vercel
environment — without `FIREHOSE_ENABLED`, the post-merge workflow keeps
its local-dev no-op behavior and never touches AWS.

## Adding more environments

Trust is scoped to a single environment per role — `environment` defaults
to `production`. To add `preview`:

```bash
# Use a separate state file so the two roles don't fight over the same
# resource names.
terraform init -reconfigure \
  -backend-config="key=infrastructure/preview/terraform.tfstate"

terraform apply -var environment=preview
```

Workspaces would work too, but separate state keys are easier to reason
about for one-off branches.

## Layout

```
terraform/
├── README.md              # You are here
├── versions.tf            # Terraform 1.10+, AWS provider 5.x
├── backend.tf             # S3 backend with use_lockfile (no DynamoDB)
├── variables.tf           # Input variables
├── locals.tf              # Derived names, account id, common tags
├── oidc.tf                # Vercel OIDC identity provider in IAM
├── s3.tf                  # Firehose + SDK destination bucket
├── roles.tf               # Lattik Studio role + Firehose service role
├── outputs.tf             # Values to paste into Vercel env
├── terraform.tfvars.example
└── .gitignore
```
